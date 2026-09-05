import { isTauri } from "@tauri-apps/api/core";

export interface SaveFileOptions {
  /** Suggested file name, including extension. */
  filename: string;
  /** MIME type used for the browser download fallback. */
  mimeType: string;
  /** Human-readable filter label shown by the native save dialog. */
  filterName: string;
  /** Extensions (without the dot) accepted by the native save dialog. */
  extensions: string[];
}

/**
 * Save a file for the user.
 *
 * In the Tauri desktop build the webview cannot trigger a download, so the
 * file goes through the native "Save as" dialog instead. In the browser the
 * classic anchor-download trick is used.
 *
 * Resolves to `false` when the user cancelled the native dialog.
 */
export async function saveFile(
  data: ArrayBuffer | string,
  options: SaveFileOptions,
): Promise<boolean> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  if (isTauri()) {
    const [{ save }, { writeFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const path = await save({
      defaultPath: options.filename,
      filters: [{ name: options.filterName, extensions: options.extensions }],
    });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: options.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = options.filename;
  link.click();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
