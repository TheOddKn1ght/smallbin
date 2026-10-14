import QRCode from "qrcode";

const margin = 4;
export function createQrMatrix(value: string) {
  return QRCode.create(value, { errorCorrectionLevel: "M" }).modules;
}

export async function createQrPng(value: string): Promise<Blob> {
  const matrix = createQrMatrix(value);
  const scale = 8;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = (matrix.size + margin * 2) * scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image export is unavailable");
  // Whole-pixel modules and a white quiet zone keep the saved image scannable.
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.get(y, x)) context.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    }
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Image export failed")), "image/png");
  });
}
