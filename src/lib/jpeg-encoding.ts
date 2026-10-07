export type JpegEncoder = "browser" | "mozjpeg"
export type JpegContentProfile = "photo" | "text"

function browserJpegBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("This browser could not encode the image as JPEG."))
    }, "image/jpeg", quality)
  })
}

export async function encodeCanvasAsJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
  encoder: JpegEncoder,
  contentProfile: JpegContentProfile = "photo",
) {
  if (encoder === "browser") return browserJpegBlob(canvas, quality)

  const context = canvas.getContext("2d")
  if (!context) throw new Error("Canvas is unavailable in this browser.")

  const { encode } = await import("@jsquash/jpeg")
  const encoded = await encode(context.getImageData(0, 0, canvas.width, canvas.height), {
    quality: Math.round(quality * 100),
    progressive: true,
    optimize_coding: true,
    trellis_multipass: true,
    auto_subsample: contentProfile === "photo",
    chroma_subsample: contentProfile === "photo" ? 2 : 0,
  })

  return new Blob([encoded], { type: "image/jpeg" })
}
