export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(",");
  const header = dataUrl.substring(0, commaIdx);
  const base64 = dataUrl.substring(commaIdx + 1);
  const mime = header.split(":")[1]?.split(";")[0] ?? "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function docFileExt(type: string): string {
  if (type === "pdf") return ".pdf";
  if (type === "png") return ".png";
  return ".jpg";
}

export function docMime(type: string): string {
  if (type === "pdf") return "application/pdf";
  if (type === "png") return "image/png";
  return "image/jpeg";
}

export function docFilename(name: string, type: string): string {
  const ext = docFileExt(type);
  return name.endsWith(ext) ? name : name + ext;
}
