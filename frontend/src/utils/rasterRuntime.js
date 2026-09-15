function rasterError(code, message, cause = null) {
  const err = new Error(message || 'Lỗi xử lý raster');
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

export function decodeImageUrl(url, signal, createImage = () => new Image()) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let img = null;

    const cleanup = () => {
      if (img) {
        img.onload = null;
        img.onerror = null;
      }
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const onAbort = () => {
      try {
        if (img) img.src = '';
      } catch {
        // ignore
      }
      const err = new Error('Image decode aborted');
      err.name = 'AbortError';
      finish(reject, err);
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      img = createImage();
      img.onload = () => {
        finish(resolve, img);
      };
      img.onerror = (err) => {
        finish(reject, rasterError('IMAGE_DECODE_FAILED', err?.message || 'Không thể giải mã ảnh raster', err));
      };

      img.src = url;

      // Hỗ trợ decode() nếu có
      if (typeof img.decode === 'function') {
        img.decode()
          .then(() => {
            finish(resolve, img);
          })
          .catch(() => {
            if (signal?.aborted) return;
            // Nếu decode() reject thì fallback về onerror đã đăng ký
          });
      }
    } catch (cause) {
      finish(reject, rasterError('IMAGE_DECODE_FAILED', cause?.message || 'Lỗi khởi tạo Image', cause));
    }
  });
}

export function createRasterRuntime(options = {}) {
  const owned = new Set();
  let created = 0;
  let revoked = 0;
  let activeBlobConversions = 0;
  let maxActiveBlobConversions = 0;
  let pendingBlobRequest = null;

  const base = {
    createCanvas: () => document.createElement('canvas'),
    createImageData: (rgba, width, height) => new ImageData(rgba, width, height),
    createImage: () => new Image(),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
  const impl = { ...base, ...options };

  let blobDelayMs = 0;
  let blobNullOnce = false;
  let decodeFailureOnce = false;

  function nativeToBlob(canvas, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let nativeStarted = false;
      let delayTimer = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };

      const onAbort = () => {
        if (settled) return;
        // canvas.toBlob không thể bị hủy sau khi đã gọi. Chỉ ghi nhận abort và
        // chờ callback native để Promise không giải phóng slot quá sớm.
        if (nativeStarted) return;
        if (delayTimer !== null) {
          clearTimeout(delayTimer);
          delayTimer = null;
        }
        const error = new Error('Raster task aborted');
        error.name = 'AbortError';
        finish(reject, error);
      };

      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });

      const performBlob = () => {
        if (signal?.aborted) return onAbort();
        if (blobNullOnce) {
          blobNullOnce = false;
          finish(reject, rasterError('RASTER_BLOB_ERROR', 'toBlob trả về null (mô phỏng)'));
          return;
        }
        try {
          nativeStarted = true;
          canvas.toBlob((blob) => {
            if (signal?.aborted) {
              const error = new Error('Raster task aborted');
              error.name = 'AbortError';
              finish(reject, error);
            } else if (!blob) {
              finish(reject, rasterError('RASTER_BLOB_ERROR', 'toBlob trả về null'));
            } else {
              finish(resolve, blob);
            }
          }, 'image/png');
        } catch (cause) {
          finish(reject, rasterError('RASTER_BLOB_ERROR', cause?.message || 'toBlob ném ngoại lệ', cause));
        }
      };

      if (blobDelayMs > 0) {
        delayTimer = setTimeout(() => {
          delayTimer = null;
          performBlob();
        }, blobDelayMs);
      } else {
        performBlob();
      }
    });
  }

  function abortError() {
    const error = new Error('Raster task aborted');
    error.name = 'AbortError';
    return error;
  }

  function startBlobRequest(request) {
    if (request.signal?.aborted) {
      request.reject(abortError());
      pumpBlobQueue();
      return;
    }

    request.signal?.removeEventListener('abort', request.onPendingAbort);
    activeBlobConversions = 1;
    maxActiveBlobConversions = Math.max(maxActiveBlobConversions, activeBlobConversions);

    let operation;
    try {
      operation = (impl.toBlob || nativeToBlob)(request.canvas, request.signal);
    } catch (cause) {
      operation = Promise.reject(cause);
    }

    Promise.resolve(operation)
      .then(request.resolve, request.reject)
      .finally(() => {
        activeBlobConversions = 0;
        pumpBlobQueue();
      });
  }

  function pumpBlobQueue() {
    if (activeBlobConversions || !pendingBlobRequest) return;
    const next = pendingBlobRequest;
    pendingBlobRequest = null;
    startBlobRequest(next);
  }

  function scheduleBlob(canvas, signal) {
    return new Promise((resolve, reject) => {
      const request = {
        canvas,
        signal,
        resolve,
        reject,
        onPendingAbort: null,
      };
      request.onPendingAbort = () => {
        if (pendingBlobRequest !== request) return;
        pendingBlobRequest = null;
        reject(abortError());
      };

      if (!activeBlobConversions) {
        startBlobRequest(request);
        return;
      }

      // Runtime dùng chung giữa các page: chỉ giữ request chờ mới nhất. Request
      // đang encode không thể hủy native và luôn được đợi tới callback.
      if (pendingBlobRequest) {
        pendingBlobRequest.signal?.removeEventListener(
          'abort',
          pendingBlobRequest.onPendingAbort
        );
        pendingBlobRequest.reject(abortError());
      }
      pendingBlobRequest = request;
      if (signal?.aborted) {
        request.onPendingAbort();
      } else {
        signal?.addEventListener('abort', request.onPendingAbort, { once: true });
      }
    });
  }

  return {
    createCanvas: impl.createCanvas,
    createImageData: impl.createImageData,
    createImage: impl.createImage,
    toBlob: scheduleBlob,
    decodeUrl(url, signal) {
      if (decodeFailureOnce) {
        decodeFailureOnce = false;
        return Promise.reject(rasterError('IMAGE_DECODE_FAILED', 'Giải mã ảnh thất bại (mô phỏng)'));
      }
      return impl.decodeUrl
        ? impl.decodeUrl(url, signal)
        : decodeImageUrl(url, signal, impl.createImage);
    },
    createObjectURL(blob) {
      const url = impl.createObjectURL(blob);
      owned.add(url);
      created += 1;
      return url;
    },
    revokeObjectURL(url) {
      if (!owned.delete(url)) return false;
      try {
        impl.revokeObjectURL(url);
      } catch {
        // ignore
      }
      revoked += 1;
      return true;
    },
    getCounters: () => ({
      createdCount: created,
      revokedCount: revoked,
      activeCount: owned.size,
      activeBlobConversions,
      pendingBlobConversions: pendingBlobRequest ? 1 : 0,
      maxActiveBlobConversions,
    }),
    setBlobDelayMs: (ms) => {
      blobDelayMs = ms;
    },
    setBlobNullOnce: (flag = true) => {
      blobNullOnce = flag;
    },
    setDecodeFailureOnce: (flag = true) => {
      decodeFailureOnce = flag;
    },
    resetCounters: () => {
      // URL đang được DOM/controller sử dụng vẫn phải nằm trong ownership set.
      // Tính chúng là baseline-created để created - revoked === active tiếp tục
      // đúng sau reset và chúng vẫn được revoke khi thay ảnh hoặc unmount.
      created = owned.size;
      revoked = 0;
      maxActiveBlobConversions = activeBlobConversions;
    },
  };
}

export const defaultRasterRuntime = createRasterRuntime();
