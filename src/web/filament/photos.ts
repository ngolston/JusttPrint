/*
 * Pictures from this computer or phone for spools, filaments and logged prints (docs/plan-10.1.md,
 * Phase 2): chosen with the file picker (on a phone, the camera too), shrunk to at most 1600 px as
 * a JPEG before they are sent, so a 12 MP photo does not travel or take room whole.
 */

const MAX_SIDE = 1600;

/** A picture file → a JPEG data URL at most MAX_SIDE wide and high. */
export async function shrinkImage(file: File, maxSide = MAX_SIDE): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not a picture`);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name} could not be read as a picture`);
  });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot shrink pictures');
  // JPEG has no transparency: a transparent PNG gets a white background, not a black one.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Ask for pictures with the file picker; resolves with the chosen files (none when cancelled). */
export function choosePictures({ multiple = false }: { multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files || [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
