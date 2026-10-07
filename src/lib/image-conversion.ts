import { encodeCanvasAsJpeg, type JpegContentProfile, type JpegEncoder } from "@/lib/jpeg-encoding"

export type OutputFormat = "image/avif" | "image/webp" | "image/jpeg" | "image/png"

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
  "image/avif": "avif",
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
}

function canvasBlob(canvas: HTMLCanvasElement, type: Exclude<OutputFormat, "image/avif">, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob?.type === type) resolve(blob)
        else if (blob) reject(new Error(`This browser cannot encode ${type.replace("image/", "")} images.`))
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
  jpegEncoder: JpegEncoder = "mozjpeg",
  jpegContentProfile: JpegContentProfile = "photo",
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
    let blob: Blob
    if (format === "image/jpeg") {
      blob = await encodeCanvasAsJpeg(canvas, quality, jpegEncoder, jpegContentProfile)
    } else if (format === "image/avif") {
      const { encode } = await import("@jsquash/avif")
      const encoded = await encode(context.getImageData(0, 0, canvas.width, canvas.height), {
        quality: Math.round(quality * 100),
      })
      blob = new Blob([encoded], { type: format })
    } else {
      blob = await canvasBlob(canvas, format, quality)
    }
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
