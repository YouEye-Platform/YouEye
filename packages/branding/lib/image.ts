export type ImageReadErrorCode =
  | "upload.typeError"
  | "upload.sizeError"
  | "upload.openError"
  | "upload.dimensionsError"
  | "upload.readError";

/** Stable failure codes keep async errors localizable in the current render. */
export class ImageReadError extends Error {
  constructor(public readonly code: ImageReadErrorCode) {
    super(code);
    this.name = "ImageReadError";
  }
}

export async function readImage(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new ImageReadError("upload.typeError");
  if (file.size > 2_000_000) throw new ImageReadError("upload.sizeError");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageReadError("upload.openError");
  }
  if (bitmap.width > 4096 || bitmap.height > 4096) {
    bitmap.close();
    throw new ImageReadError("upload.dimensionsError");
  }
  bitmap.close();
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new ImageReadError("upload.readError"));
    r.readAsDataURL(file);
  });
}
