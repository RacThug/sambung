/**
 * PUT a file to a presigned storage URL, reporting upload progress.
 * XMLHttpRequest instead of fetch: fetch has no upload-progress events
 * (page-spec §4.5 wants per-file progress). The bytes go straight to object
 * storage - never through our API. (architecture §3.6)
 */
export function uploadToPresignedUrl(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    // Must repeat the presigned content type exactly - it is a SIGNED header;
    // anything else is rejected by storage with a signature mismatch.
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed - network error"));
    xhr.send(file);
  });
}
