export type OutputFormat = "image/webp" | "image/jpeg" | "image/png"

export type ConvertedImage = {
  id: string
  source: File
  blob: Blob
  outputName: string
  previewUrl: string
  width: number
  height: number
}

const extensions: Record<OutputFormat, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
}

function canvasBlob(canvas: HTMLCanvasElement, type: OutputFormat, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error("This browser could not encode the selected format."))
      },
      type,
      type === "image/png" ? undefined : quality,
    )
  })
}

export async function convertImage(
  source: File,
  format: OutputFormat,
  quality: number,
): Promise<ConvertedImage> {
  const bitmap = await createImageBitmap(source)

  try {
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height

    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas is unavailable in this browser.")

    if (format === "image/jpeg") {
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, canvas.width, canvas.height)
    }

    context.drawImage(bitmap, 0, 0)
    const blob = await canvasBlob(canvas, format, quality)
    const baseName = source.name.replace(/\.[^.]+$/, "")
    const outputName = `${baseName}.${extensions[format]}`

    return {
      id: `${source.name}-${source.lastModified}-${format}`,
      source,
      blob,
      outputName,
      previewUrl: URL.createObjectURL(blob),
      width: bitmap.width,
      height: bitmap.height,
    }
  } finally {
    bitmap.close()
  }
}
