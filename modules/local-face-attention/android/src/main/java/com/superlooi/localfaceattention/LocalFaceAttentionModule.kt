package com.superlooi.localfaceattention

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import android.util.Base64
import android.util.Range
import android.util.Size
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.max

class LocalFaceAttentionModule : Module() {
  private val lock = Any()
  private val detectorBusy = AtomicBoolean(false)
  private val framesAnalyzed = AtomicLong(0)
  private val captureStillInFlight = AtomicBoolean(false)
  private val pendingStillCaptureIssued = AtomicBoolean(false)
  private var running = false
  private var cameraId: String? = null
  private var lensFacingName = "unknown"
  private var sensorOrientation = 0
  private var cameraDevice: CameraDevice? = null
  private var captureSession: CameraCaptureSession? = null
  private var imageReader: ImageReader? = null
  private var cameraThread: HandlerThread? = null
  private var cameraHandler: Handler? = null
  private var targetFpsRange: Range<Int>? = null
  private var detector: FaceDetector? = null
  private var pendingDetectorClose: FaceDetector? = null
  private var lastAnalysisAtMs = 0L

  // Explicit still-capture (voice "look here / look at this") state. This is a
  // fully separate short-lived Camera2 pipeline so the always-on YUV face
  // analysis path stays untouched. Nothing here writes to disk: the JPEG lives
  // only long enough to be Base64-encoded into the JS result map.
  private var pendingCaptureRestoreFacing: String? = null
  private var stillCameraDevice: CameraDevice? = null
  private var stillCaptureSession: CameraCaptureSession? = null
  private var stillImageReader: ImageReader? = null
  private var stillWarmupReader: ImageReader? = null
  private var stillThread: HandlerThread? = null
  private var stillHandler: Handler? = null
  @Volatile private var stillCameraOpened = false
  @Volatile private var stillSessionReady = false
  @Volatile private var stillCaptureFailed: String? = null
  @Volatile private var stillJpegBytes: ByteArray? = null
  @Volatile private var stillImageWidth: Int? = null
  @Volatile private var stillImageHeight: Int? = null
  @Volatile private var latestExposureTimeNs: Long? = null
  @Volatile private var latestSensitivityIso: Int? = null
  @Volatile private var latestAeState: Int? = null
  @Volatile private var latestAwbState: Int? = null
  @Volatile private var latestAfState: Int? = null
  @Volatile private var lastStillWidth: Int? = null
  @Volatile private var lastStillHeight: Int? = null
  @Volatile private var lastStillAutofocusMode: Int? = null
  @Volatile private var lastStillFlashAvailable: Boolean? = null

  override fun definition() = ModuleDefinition {
    Name("LocalFaceAttention")
    Events("onFaceFrame", "onFaceAttentionError")

    AsyncFunction("start") Coroutine ::startCamera
    AsyncFunction("stop") Coroutine ::stopCameraAndStatus
    AsyncFunction("getStatus") Coroutine ::status
    AsyncFunction("captureStill") Coroutine { cameraFacing: String ->
      captureStill(cameraFacing)
    }

    OnDestroy {
      stopStillCamera()
      stopCamera()
    }
  }

  private fun context(): Context = appContext.reactContext?.applicationContext
    ?: throw IllegalStateException("Android application context is unavailable")

  private fun hasPermission(): Boolean = ContextCompat.checkSelfPermission(
    context(),
    Manifest.permission.CAMERA
  ) == PackageManager.PERMISSION_GRANTED


  private fun createDetector(): FaceDetector {
    val options = FaceDetectorOptions.Builder()
      .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
      .setMinFaceSize(0.12f)
      .enableTracking()
      .build()
    return FaceDetection.getClient(options)
  }

  private fun selectTargetFpsRange(characteristics: CameraCharacteristics): Range<Int>? {
    val ranges = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
      ?.toList()
      .orEmpty()
    return ranges.firstOrNull { it.lower == 15 && it.upper == 15 }
      ?: ranges.filter { it.upper <= 20 }.maxByOrNull { it.upper }
  }

  private fun stopCameraAndStatus(): Map<String, Any?> {
    stopCamera()
    return status()
  }

  private fun startCamera(): Map<String, Any?> {
    synchronized(lock) {
      if (running) return status()
      if (captureStillInFlight.get()) {
        throw IllegalStateException("Camera is busy capturing an explicit visual snapshot")
      }
      if (!hasPermission()) throw SecurityException("Camera permission is required for local face attention")

      val manager = context().getSystemService(Context.CAMERA_SERVICE) as CameraManager
      val selected = selectCamera(manager)
        ?: throw IllegalStateException("No camera is available")

      return startAnalysisStreamLocked(manager, selected.first, selected.second)
    }
  }

  private fun startAnalysisStreamLocked(manager: CameraManager, selectedId: String, selectedFacing: String): Map<String, Any?> {
    cameraId = selectedId
    lensFacingName = selectedFacing
    val characteristics = manager.getCameraCharacteristics(selectedId)
    sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
    targetFpsRange = selectTargetFpsRange(characteristics)
    // Reuse the detector staged by switchCameraForExplicitCapture when it already
    // matches this stream; otherwise create a fresh one.
    if (detector == null) {
      detector = createDetector()
    }

    val thread = HandlerThread("my-looi-face-attention")
    thread.start()
    cameraThread = thread
    cameraHandler = Handler(thread.looper)
    lastAnalysisAtMs = 0L
    framesAnalyzed.set(0)

    val analysisSize = selectAnalysisSize(characteristics)
    val reader = ImageReader.newInstance(
      analysisSize.width,
      analysisSize.height,
      ImageFormat.YUV_420_888,
      2
    )
    imageReader = reader
    reader.setOnImageAvailableListener({ source ->
      val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
      analyze(image)
    }, cameraHandler)

    running = true
    try {
      manager.openCamera(selectedId, cameraStateCallback, cameraHandler)
    } catch (error: Throwable) {
      running = false
      stopCameraLocked()
      throw error
    }
    return status()
  }

  private fun selectAnalysisSize(characteristics: CameraCharacteristics): Size {
    val sizes = characteristics
      .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
      ?.getOutputSizes(ImageFormat.YUV_420_888)
      ?.toList()
      .orEmpty()
    if (sizes.isEmpty()) return Size(ANALYSIS_WIDTH, ANALYSIS_HEIGHT)
    val targetArea = ANALYSIS_WIDTH * ANALYSIS_HEIGHT
    return sizes.minByOrNull { size -> abs(size.width * size.height - targetArea) } ?: sizes.first()
  }

  private fun selectCamera(manager: CameraManager): Pair<String, String>? {
    var fallback: Pair<String, String>? = null
    for (id in manager.cameraIdList) {
      val facing = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING)
      val name = when (facing) {
        CameraCharacteristics.LENS_FACING_FRONT -> "front"
        CameraCharacteristics.LENS_FACING_BACK -> "back"
        CameraCharacteristics.LENS_FACING_EXTERNAL -> "external"
        else -> "unknown"
      }
      if (fallback == null) fallback = id to name
      if (facing == CameraCharacteristics.LENS_FACING_FRONT) return id to name
    }
    return fallback
  }

  /**
   * Resolve the camera for an explicit capture. Prefers a logical multi-camera
   * (the fused rear module) over a bare physical lens id when the device
   * exposes both for the requested facing.
   */
  private fun selectCamera(manager: CameraManager, requestedFacing: String): Pair<String, String>? {
    val wantedFacing = when (requestedFacing) {
      "front" -> CameraCharacteristics.LENS_FACING_FRONT
      "back" -> CameraCharacteristics.LENS_FACING_BACK
      else -> return null
    }
    var fallback: Pair<String, String>? = null
    for (id in manager.cameraIdList) {
      val characteristics = manager.getCameraCharacteristics(id)
      val facing = characteristics.get(CameraCharacteristics.LENS_FACING) ?: continue
      if (facing != wantedFacing) continue
      val name = if (facing == CameraCharacteristics.LENS_FACING_BACK) "back" else "front"
      val capabilities = characteristics.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)
      if (capabilities != null &&
        capabilities.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA)
      ) {
        return id to name
      }
      if (fallback == null) fallback = id to name
    }
    return fallback
  }

  /**
   * Stop the current analysis stream and stage the requested camera for an
   * explicit capture. Face detection is paused for the capture: it only runs
   * on the front camera where the always-on YUV analysis lives; a back-camera
   * still needs no detector.
   */
  private fun switchCameraForExplicitCapture(manager: CameraManager, requestedFacing: String): Pair<String, String> {
    synchronized(lock) {
      running = false
      stopCameraLocked()
      val selected = selectCamera(manager, requestedFacing)
        ?: throw IllegalStateException("No $requestedFacing camera is available for visual look")
      cameraId = selected.first
      lensFacingName = selected.second
      val characteristics = manager.getCameraCharacteristics(selected.first)
      sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
      targetFpsRange = selectTargetFpsRange(characteristics)
      detector = if (lensFacingName == "front") createDetector() else null
      return selected
    }
  }

  private val cameraStateCallback = object : CameraDevice.StateCallback() {
    override fun onOpened(camera: CameraDevice) {
      synchronized(lock) {
        if (!running) {
          camera.close()
          return
        }
        cameraDevice = camera
        createCaptureSession(camera)
      }
    }

    override fun onDisconnected(camera: CameraDevice) {
      camera.close()
      synchronized(lock) {
        if (cameraDevice === camera) cameraDevice = null
        running = false
      }
      emitError("camera-disconnected", "Camera disconnected")
    }

    override fun onError(camera: CameraDevice, error: Int) {
      camera.close()
      synchronized(lock) {
        if (cameraDevice === camera) cameraDevice = null
        running = false
      }
      emitError("camera-open", "Camera error $error")
    }
  }

  @Suppress("DEPRECATION")
  private fun createCaptureSession(camera: CameraDevice) {
    val reader = imageReader ?: return
    camera.createCaptureSession(
      listOf(reader.surface),
      object : CameraCaptureSession.StateCallback() {
        override fun onConfigured(session: CameraCaptureSession) {
          synchronized(lock) {
            if (!running || cameraDevice !== camera) {
              session.close()
              return
            }
            captureSession = session
            try {
              val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(reader.surface)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                targetFpsRange?.let { set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
              }.build()
              session.setRepeatingRequest(request, null, cameraHandler)
            } catch (error: Throwable) {
              emitError("capture-start", error.message ?: error.javaClass.simpleName)
            }
          }
        }

        override fun onConfigureFailed(session: CameraCaptureSession) {
          session.close()
          emitError("capture-configure", "Could not configure local face-attention capture")
        }
      },
      cameraHandler
    )
  }

  /**
   * One explicit, user-requested still (voice "look here / look at this").
   * The always-on YUV analysis stream is stopped, the requested camera runs a
   * short-lived JPEG pipeline (warmup + bounded AE/AF/AWB convergence wait,
   * then a TEMPLATE_STILL_CAPTURE burst), the JPEG is Base64-encoded in memory
   * only, and the original face-attention stream is restored afterwards.
   */
  private fun captureStill(cameraFacing: String): Map<String, Any?> {
    if (cameraFacing != "front" && cameraFacing != "back") {
      throw IllegalArgumentException("Unknown camera facing \"$cameraFacing\" for visual look (expected \"front\" or \"back\")")
    }
    if (!hasPermission()) throw SecurityException("Camera permission is required for visual look")
    if (!captureStillInFlight.compareAndSet(false, true)) {
      throw IllegalStateException("A visual snapshot is already in progress")
    }

    val deadlineMs = System.currentTimeMillis() + STILL_CAPTURE_TIMEOUT_MS
    try {
      val manager = context().getSystemService(Context.CAMERA_SERVICE) as CameraManager
      synchronized(lock) {
        pendingCaptureRestoreFacing = if (running) lensFacingName else null
      }

      val selected = switchCameraForExplicitCapture(manager, cameraFacing)
      val characteristics = manager.getCameraCharacteristics(selected.first)
      val stillSize = selectStillSize(characteristics, selected.second)
      val afModes = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)?.toList().orEmpty()
      val afSupported = afModes.any { it != CameraCharacteristics.CONTROL_AF_MODE_OFF }
      val flashAvailable = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
      val autofocusMode = if (afSupported) {
        CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE
      } else {
        CaptureRequest.CONTROL_AF_MODE_OFF
      }
      val aeMode = if (flashAvailable) {
        CaptureRequest.CONTROL_AE_MODE_ON_AUTO_FLASH
      } else {
        CaptureRequest.CONTROL_AE_MODE_ON
      }

      resetStillPipelineState()
      val thread = HandlerThread("my-looi-still-capture")
      thread.start()
      stillThread = thread
      stillHandler = Handler(thread.looper)

      // The JPEG reader receives exactly one frame: the still burst. A small
      // YUV warmup stream drives AE/AF/AWB convergence before that burst.
      val reader = ImageReader.newInstance(stillSize.width, stillSize.height, ImageFormat.JPEG, 2)
      stillImageReader = reader
      reader.setOnImageAvailableListener({ source ->
        val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
        try {
          val plane = image.planes.firstOrNull() ?: return@setOnImageAvailableListener
          val buffer = plane.buffer
          val bytes = ByteArray(buffer.remaining())
          buffer.get(bytes)
          stillJpegBytes = bytes
          stillImageWidth = image.width
          stillImageHeight = image.height
        } finally {
          image.close()
        }
      }, stillHandler)

      val warmupReader = ImageReader.newInstance(
        STILL_WARMUP_WIDTH,
        STILL_WARMUP_HEIGHT,
        ImageFormat.YUV_420_888,
        2
      )
      stillWarmupReader = warmupReader
      warmupReader.setOnImageAvailableListener({ source ->
        val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
        image.close()
      }, stillHandler)

      manager.openCamera(selected.first, stillCameraStateCallback, stillHandler)
      waitForStillCondition({ stillCameraOpened }, deadlineMs, "camera-open")

      val device = stillCameraDevice ?: throw IllegalStateException("Camera for visual look closed before capture")
      @Suppress("DEPRECATION")
      device.createCaptureSession(
        listOf(warmupReader.surface, reader.surface),
        stillSessionStateCallback,
        stillHandler
      )
      waitForStillCondition({ stillSessionReady }, deadlineMs, "session-configure")

      val session = stillCaptureSession ?: throw IllegalStateException("Capture session for visual look closed")
      val repeating = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
        addTarget(warmupReader.surface)
        set(CaptureRequest.CONTROL_AF_MODE, autofocusMode)
        set(CaptureRequest.CONTROL_AE_MODE, aeMode)
      }.build()
      session.setRepeatingRequest(repeating, stillCaptureCallback, stillHandler)

      // Fixed warmup so the sensor is past its first frames, then a bounded
      // wait for AE/AF/AWB to settle. Back cameras without AF skip the AF
      // check inside exposureReadyForStill.
      val warmupUntilMs = minOf(deadlineMs, System.currentTimeMillis() + STILL_CAMERA_MIN_WARMUP_MS)
      while (System.currentTimeMillis() < warmupUntilMs && stillCaptureFailed == null) {
        Thread.sleep(STILL_POLL_INTERVAL_MS)
      }
      val convergenceUntilMs = minOf(deadlineMs, System.currentTimeMillis() + STILL_CAMERA_CONVERGENCE_TIMEOUT_MS)
      while (System.currentTimeMillis() < convergenceUntilMs &&
        !exposureReadyForStill(latestAeState, latestAwbState, latestAfState, afSupported) &&
        stillCaptureFailed == null
      ) {
        Thread.sleep(STILL_POLL_INTERVAL_MS)
      }

      pendingStillCaptureIssued.set(true)
      val stillRequest = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
        addTarget(reader.surface)
        set(CaptureRequest.JPEG_QUALITY, STILL_JPEG_QUALITY.toByte())
        set(CaptureRequest.JPEG_ORIENTATION, imageRotationDegrees())
        set(CaptureRequest.CONTROL_AF_MODE, autofocusMode)
        set(CaptureRequest.CONTROL_AE_MODE, aeMode)
      }.build()
      session.capture(stillRequest, stillCaptureCallback, stillHandler)
      waitForStillCondition({ stillJpegBytes != null }, deadlineMs, "jpeg-capture")

      // Give the still's own CaptureResult a moment to land (it carries the
      // exposure metadata we report) but never block the answer on a lazy HAL.
      val metadataUntilMs = System.currentTimeMillis() + STILL_METADATA_GRACE_MS
      while (pendingStillCaptureIssued.get() && System.currentTimeMillis() < metadataUntilMs) {
        Thread.sleep(STILL_POLL_INTERVAL_MS)
      }

      val bytes = stillJpegBytes ?: throw IllegalStateException("No JPEG arrived for the visual snapshot")
      val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
      val width = stillImageWidth ?: stillSize.width
      val height = stillImageHeight ?: stillSize.height
      val exposureTimeNs = latestExposureTimeNs
      val sensitivityIso = latestSensitivityIso
      lastStillWidth = width
      lastStillHeight = height
      lastStillAutofocusMode = autofocusMode
      lastStillFlashAvailable = flashAvailable
      return mapOf(
        "mimeType" to "image/jpeg",
        "base64" to base64,
        "width" to width,
        "height" to height,
        "timestampMs" to System.currentTimeMillis(),
        "cameraFacing" to lensFacingName,
        "cameraId" to cameraId,
        "autofocusMode" to autofocusMode,
        "flashAvailable" to flashAvailable,
        "aeState" to latestAeState,
        "awbState" to latestAwbState,
        "afState" to latestAfState,
        "exposureTimeMs" to exposureTimeNs?.let { it / 1_000_000.0 },
        "sensitivityIso" to sensitivityIso,
        "lowLightLikely" to isLowLightLikely(exposureTimeNs, sensitivityIso)
      )
    } finally {
      stopStillCamera()
      restoreAnalysisAfterStill()
      captureStillInFlight.set(false)
    }
  }

  private fun selectStillSize(characteristics: CameraCharacteristics, facingName: String): Size {
    val sizes = characteristics
      .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
      ?.getOutputSizes(ImageFormat.JPEG)
      ?.toList()
      .orEmpty()
    val targetWidth = if (facingName == "back") BACK_STILL_TARGET_WIDTH else FRONT_STILL_TARGET_WIDTH
    val targetHeight = if (facingName == "back") BACK_STILL_TARGET_HEIGHT else FRONT_STILL_TARGET_HEIGHT
    val targetArea = targetWidth.toLong() * targetHeight.toLong()
    val maxArea = if (facingName == "back") BACK_STILL_MAX_AREA else 0L
    val candidates = sizes.filter { size ->
      maxArea <= 0L || size.width.toLong() * size.height.toLong() <= maxArea
    }.ifEmpty { sizes }
    return candidates.minByOrNull { size -> abs(size.width.toLong() * size.height.toLong() - targetArea) }
      ?: Size(targetWidth, targetHeight)
  }

  private fun exposureReadyForStill(aeState: Int?, awbState: Int?, afState: Int?, afSupported: Boolean): Boolean {
    val aeReady = aeState == null ||
      aeState == CameraCharacteristics.CONTROL_AE_STATE_CONVERGED ||
      aeState == CameraCharacteristics.CONTROL_AE_STATE_LOCKED ||
      aeState == CameraCharacteristics.CONTROL_AE_STATE_FLASH_REQUIRED
    val awbReady = awbState == null || awbState == CameraCharacteristics.CONTROL_AWB_STATE_CONVERGED
    val afReady = !afSupported || afState == null ||
      afState == CameraCharacteristics.CONTROL_AF_STATE_PASSIVE_FOCUSED ||
      afState == CameraCharacteristics.CONTROL_AF_STATE_FOCUSED_LOCKED
    return aeReady && awbReady && afReady
  }

  private fun isLowLightLikely(exposureTimeNs: Long?, sensitivityIso: Int?): Boolean =
    (exposureTimeNs ?: 0L) >= LOW_LIGHT_EXPOSURE_TIME_NS || (sensitivityIso ?: 0) >= LOW_LIGHT_MIN_ISO

  private fun waitForStillCondition(condition: () -> Boolean, deadlineMs: Long, stage: String) {
    while (System.currentTimeMillis() < deadlineMs) {
      stillCaptureFailed?.let { failure ->
        throw IllegalStateException("Visual snapshot failed ($failure) at $stage")
      }
      if (condition()) return
      Thread.sleep(STILL_POLL_INTERVAL_MS)
    }
    throw IllegalStateException("Camera did not produce a visual snapshot in time ($stage)")
  }

  private fun resetStillPipelineState() {
    stillCameraOpened = false
    stillSessionReady = false
    stillCaptureFailed = null
    stillJpegBytes = null
    stillImageWidth = null
    stillImageHeight = null
    latestExposureTimeNs = null
    latestSensitivityIso = null
    latestAeState = null
    latestAwbState = null
    latestAfState = null
    pendingStillCaptureIssued.set(false)
  }

  private val stillCameraStateCallback = object : CameraDevice.StateCallback() {
    override fun onOpened(camera: CameraDevice) {
      stillCameraDevice = camera
      stillCameraOpened = true
    }

    override fun onDisconnected(camera: CameraDevice) {
      camera.close()
      if (stillCameraDevice === camera) stillCameraDevice = null
      stillCaptureFailed = "camera-disconnected"
    }

    override fun onError(camera: CameraDevice, error: Int) {
      camera.close()
      if (stillCameraDevice === camera) stillCameraDevice = null
      stillCaptureFailed = "camera-error-$error"
    }
  }

  private val stillSessionStateCallback = object : CameraCaptureSession.StateCallback() {
    override fun onConfigured(session: CameraCaptureSession) {
      stillCaptureSession = session
      stillSessionReady = true
    }

    override fun onConfigureFailed(session: CameraCaptureSession) {
      session.close()
      stillCaptureFailed = "session-configure"
    }
  }

  private val stillCaptureCallback = object : CameraCaptureSession.CaptureCallback() {
    override fun onCaptureCompleted(
      session: CameraCaptureSession,
      request: CaptureRequest,
      result: TotalCaptureResult
    ) {
      latestExposureTimeNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME)
      latestSensitivityIso = result.get(CaptureResult.SENSOR_SENSITIVITY)
      latestAeState = result.get(CaptureResult.CONTROL_AE_STATE)
      latestAwbState = result.get(CaptureResult.CONTROL_AWB_STATE)
      latestAfState = result.get(CaptureResult.CONTROL_AF_STATE)
      // The completed request that consumes this flag is the still burst: its
      // metadata is the exposure of record for the returned snapshot.
      pendingStillCaptureIssued.compareAndSet(true, false)
    }
  }

  private fun stopStillCamera() {
    try { stillCaptureSession?.stopRepeating() } catch (_: Throwable) {}
    try { stillCaptureSession?.abortCaptures() } catch (_: Throwable) {}
    try { stillCaptureSession?.close() } catch (_: Throwable) {}
    stillCaptureSession = null
    try { stillCameraDevice?.close() } catch (_: Throwable) {}
    stillCameraDevice = null
    try { stillImageReader?.close() } catch (_: Throwable) {}
    stillImageReader = null
    try { stillWarmupReader?.close() } catch (_: Throwable) {}
    stillWarmupReader = null
    stillCameraOpened = false
    stillSessionReady = false

    val thread = stillThread
    stillHandler = null
    stillThread = null
    try { thread?.quitSafely() } catch (_: Throwable) {}
  }

  /**
   * After an explicit capture, bring the face-attention analysis stream back
   * on the camera it was using before the capture. An explicit stop() during
   * the capture cancels the restart (stopCamera clears the pending facing).
   */
  private fun restoreAnalysisAfterStill() {
    val restoreFacing = synchronized(lock) {
      val facing = pendingCaptureRestoreFacing
      pendingCaptureRestoreFacing = null
      facing
    } ?: return
    try {
      val manager = context().getSystemService(Context.CAMERA_SERVICE) as CameraManager
      synchronized(lock) {
        if (running) return
        val selected = selectCamera(manager, restoreFacing) ?: selectCamera(manager) ?: return
        startAnalysisStreamLocked(manager, selected.first, selected.second)
      }
    } catch (error: Throwable) {
      emitError("still-restore", error.message ?: error.javaClass.simpleName)
    }
  }

  private fun analyze(image: Image) {
    if (!running) {
      image.close()
      return
    }

    val now = System.currentTimeMillis()
    if (now - lastAnalysisAtMs < MIN_ANALYSIS_INTERVAL_MS || !detectorBusy.compareAndSet(false, true)) {
      image.close()
      return
    }
    lastAnalysisAtMs = now

    val activeDetector = detector
    if (activeDetector == null) {
      detectorBusy.set(false)
      image.close()
      return
    }

    val rotation = imageRotationDegrees()
    val input = try {
      InputImage.fromMediaImage(image, rotation)
    } catch (error: Throwable) {
      detectorBusy.set(false)
      image.close()
      emitError("input-image", error.message ?: error.javaClass.simpleName)
      return
    }

    activeDetector.process(input)
      .addOnSuccessListener { faces ->
        framesAnalyzed.incrementAndGet()
        if (running) emitFaces(faces, image.width, image.height, rotation)
      }
      .addOnFailureListener { error ->
        emitError("face-detection", error.message ?: error.javaClass.simpleName)
      }
      .addOnCompleteListener {
        image.close()
        detectorBusy.set(false)
        synchronized(lock) {
          val pending = pendingDetectorClose
          pendingDetectorClose = null
          try { pending?.close() } catch (_: Throwable) {}
        }
      }
  }

  private fun emitFaces(faces: List<Face>, rawWidth: Int, rawHeight: Int, rotation: Int) {
    val rotated = rotation == 90 || rotation == 270
    val width = max(1, if (rotated) rawHeight else rawWidth).toFloat()
    val height = max(1, if (rotated) rawWidth else rawHeight).toFloat()
    val primary = faces.maxByOrNull { it.boundingBox.width().toLong() * it.boundingBox.height().toLong() }
    val normalized = primary?.let { face ->
      val rect = face.boundingBox
      val left = (rect.left / width).coerceIn(0f, 1f)
      val top = (rect.top / height).coerceIn(0f, 1f)
      val right = (rect.right / width).coerceIn(0f, 1f)
      val bottom = (rect.bottom / height).coerceIn(0f, 1f)
      mapOf(
        "left" to left,
        "top" to top,
        "right" to right,
        "bottom" to bottom,
        "centerX" to ((left + right) / 2f),
        "centerY" to ((top + bottom) / 2f),
        "width" to (right - left).coerceAtLeast(0f),
        "height" to (bottom - top).coerceAtLeast(0f)
      )
    }

    sendEvent("onFaceFrame", mapOf(
      "timestampMs" to System.currentTimeMillis(),
      "faceCount" to faces.size,
      "primary" to normalized
    ))
  }

  @Suppress("DEPRECATION")
  private fun imageRotationDegrees(): Int {
    val activity = appContext.currentActivity
    val displayRotation = activity?.windowManager?.defaultDisplay?.rotation ?: Surface.ROTATION_0
    val deviceDegrees = when (displayRotation) {
      Surface.ROTATION_90 -> 90
      Surface.ROTATION_180 -> 180
      Surface.ROTATION_270 -> 270
      else -> 0
    }
    return if (lensFacingName == "front") {
      (sensorOrientation + deviceDegrees) % 360
    } else {
      (sensorOrientation - deviceDegrees + 360) % 360
    }
  }

  private fun stopCamera() {
    synchronized(lock) {
      running = false
      // An explicit stop must also cancel any pending post-capture restart.
      pendingCaptureRestoreFacing = null
      stopCameraLocked()
    }
  }

  private fun stopCameraLocked() {
    try { captureSession?.stopRepeating() } catch (_: Throwable) {}
    try { captureSession?.abortCaptures() } catch (_: Throwable) {}
    try { captureSession?.close() } catch (_: Throwable) {}
    captureSession = null
    try { cameraDevice?.close() } catch (_: Throwable) {}
    cameraDevice = null
    try { imageReader?.close() } catch (_: Throwable) {}
    imageReader = null

    val thread = cameraThread
    cameraHandler = null
    cameraThread = null
    try { thread?.quitSafely() } catch (_: Throwable) {}

    val detectorToClose = detector
    detector = null
    if (detectorToClose != null) {
      if (detectorBusy.get() && pendingDetectorClose == null) {
        pendingDetectorClose = detectorToClose
      } else {
        try { detectorToClose.close() } catch (_: Throwable) {}
      }
    }
    targetFpsRange = null
    // Do not clear detectorBusy here: an in-flight ML Kit task still owns its Image.
    // Its completion listener is the only place that releases that image and gate,
    // then closes the detector that belonged to the stopped camera session.
  }

  private fun emitError(stage: String, message: String) {
    sendEvent("onFaceAttentionError", mapOf("stage" to stage, "message" to message))
  }

  private fun status(): Map<String, Any?> = mapOf(
    "supported" to true,
    "running" to running,
    "permissionGranted" to hasPermission(),
    "cameraId" to cameraId,
    "lensFacing" to lensFacingName,
    "framesAnalyzed" to framesAnalyzed.get(),
    "analysisWidth" to ANALYSIS_WIDTH,
    "analysisHeight" to ANALYSIS_HEIGHT,
    "targetFps" to targetFpsRange?.upper,
    "stillWidth" to lastStillWidth,
    "stillHeight" to lastStillHeight,
    "autofocusMode" to lastStillAutofocusMode,
    "flashAvailable" to lastStillFlashAvailable
  )

  companion object {
    private const val ANALYSIS_WIDTH = 640
    private const val ANALYSIS_HEIGHT = 480
    private const val MIN_ANALYSIS_INTERVAL_MS = 140L

    private const val STILL_JPEG_QUALITY = 95
    private const val STILL_CAPTURE_TIMEOUT_MS = 8_000L
    private const val STILL_CAMERA_MIN_WARMUP_MS = 450L
    private const val STILL_CAMERA_CONVERGENCE_TIMEOUT_MS = 1_600L
    private const val STILL_METADATA_GRACE_MS = 400L
    private const val STILL_POLL_INTERVAL_MS = 20L
    private const val STILL_WARMUP_WIDTH = 320
    private const val STILL_WARMUP_HEIGHT = 240
    private const val FRONT_STILL_TARGET_WIDTH = 2592
    private const val FRONT_STILL_TARGET_HEIGHT = 1944
    private const val BACK_STILL_TARGET_WIDTH = 3264
    private const val BACK_STILL_TARGET_HEIGHT = 2448
    private const val BACK_STILL_MAX_AREA = 8_500_000L
    private const val LOW_LIGHT_EXPOSURE_TIME_NS = 100_000_000L
    private const val LOW_LIGHT_MIN_ISO = 800
  }
}
