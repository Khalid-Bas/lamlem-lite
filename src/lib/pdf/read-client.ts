"use client";

import type { RawItem } from "./layout.ts";

/**
 * Browser-side PDF text extraction.
 *
 * Parsing runs on the device that uploads the file, not on Vercel. That keeps
 * serverless functions small and fast, avoids the request-body limit on large
 * label PDFs, and sidesteps having to ship Arabic font data to the server.
 */

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      // The worker is bundled with the app rather than fetched from a CDN, so
      // a blocked or offline network cannot break importing.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export interface PdfReadResult {
  pages: RawItem[][];
  pageCount: number;
}

/** Extracts positioned text items for every page of a PDF file. */
export async function readPdfItems(
  file: File | ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): Promise<PdfReadResult> {
  const pdfjs = await loadPdfJs();
  const data =
    file instanceof ArrayBuffer ? file : await file.arrayBuffer();

  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const pages: RawItem[][] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .filter((it): it is Extract<typeof it, { str: string }> => "str" in it)
        .map((it) => ({
          str: it.str,
          transform: it.transform as number[],
          width: it.width,
          height: it.height,
        })),
    );
    onProgress?.(i, doc.numPages);
  }

  await doc.destroy();
  return { pages, pageCount: doc.numPages };
}
