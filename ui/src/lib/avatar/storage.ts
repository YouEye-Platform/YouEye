/**
 * Avatar Storage
 *
 * Handles avatar file processing (resize + WebP conversion) and storage.
 * Uses sharp for image processing. Stores files on a persistent volume.
 */

import { mkdir, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";

const AVATAR_DIR = "/var/lib/youeye/ui-data/avatars";
const MAX_DIMENSION = 256;
const MAX_OUTPUT_SIZE = 256 * 1024; // 256KB

/**
 * Process and save an avatar image.
 * Resizes to 256x256 max, converts to WebP, and stores on disk.
 */
export async function saveAvatar(
  userId: string,
  buffer: Buffer
): Promise<{ storagePath: string; sizeBytes: number }> {
  await mkdir(AVATAR_DIR, { recursive: true });

  // Dynamic import of sharp (native module)
  const sharp = (await import("sharp")).default;

  let processed = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: "cover",
      position: "center",
    })
    .webp({ quality: 85 })
    .toBuffer();

  // If still too large, reduce quality
  if (processed.length > MAX_OUTPUT_SIZE) {
    processed = await sharp(buffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: "cover",
        position: "center",
      })
      .webp({ quality: 60 })
      .toBuffer();
  }

  const storagePath = `${AVATAR_DIR}/${userId}.webp`;
  await writeFile(storagePath, processed, { mode: 0o644 });

  return { storagePath, sizeBytes: processed.length };
}

/**
 * Delete a user's avatar file from disk.
 */
export async function deleteAvatar(userId: string): Promise<void> {
  const filePath = `${AVATAR_DIR}/${userId}.webp`;
  if (existsSync(filePath)) {
    await unlink(filePath);
  }
}
