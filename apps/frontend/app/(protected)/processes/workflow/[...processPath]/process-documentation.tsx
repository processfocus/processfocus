import { readFile } from "node:fs/promises"
import { dirname, extname, relative, resolve } from "node:path"
import Image from "next/image"
import type React from "react"
import type { Components } from "react-markdown"
import Markdown, { defaultUrlTransform } from "react-markdown"
import {
  getFrontendManifest,
  resolveFrontendManifestDocsDirectoryPath,
} from "@/lib/frontend-manifest-store"

export async function ProcessDocumentation({
  processPath,
}: {
  processPath: string
}) {
  const documentationPath = getProcessDocumentationPath(processPath)
  if (!documentationPath) return null

  const markdown = await loadProcessDocumentation(documentationPath)
  if (!markdown) return null

  return (
    <section className="mt-8 border-t border-slate-200 pt-8 dark:border-slate-800">
      <div className="mb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-500 dark:text-blue-400">
          Process notes
        </p>
      </div>
      <Markdown components={markdownComponents} urlTransform={urlTransform}>
        {markdown}
      </Markdown>
    </section>
  )
}

function getProcessDocumentationPath(processPath: string) {
  return getFrontendManifest().processes.documentation.find(
    (entry) => entry.processPath === processPath,
  )?.documentationPath
}

async function loadProcessDocumentation(documentationPath: string) {
  const docsRoot = resolveFrontendManifestDocsDirectoryPath()
  if (!docsRoot) return undefined

  const docsRelativePath = documentationPath.replace(/^docs\//, "")
  const absolutePath = resolve(docsRoot, docsRelativePath)
  if (!isInsideDirectory(docsRoot, absolutePath)) return undefined

  try {
    const markdown = await readFile(absolutePath, "utf8")
    return await inlineRelativeImages(markdown, dirname(absolutePath), docsRoot)
  } catch (error) {
    console.warn("Failed to load process documentation", {
      documentationPath,
      error,
    })
    return undefined
  }
}

export async function inlineRelativeImages(
  markdown: string,
  markdownDirectory: string,
  orgRoot: string,
) {
  const imagePattern = /!\[([^\]]*)\]\((\S+)(\s+[^)]*)?\)/g
  let result = ""
  let lastIndex = 0
  let match = imagePattern.exec(markdown)

  while (match !== null) {
    result += markdown.slice(lastIndex, match.index)

    const alt = match[1] ?? ""
    const src = match[2] ?? ""
    const title = match[3] ?? ""
    const rewrittenSrc = isRelativeImageSource(src)
      ? await imageFileToDataUrl(resolve(markdownDirectory, src), orgRoot)
      : src

    result += `![${alt}](${rewrittenSrc ?? src}${title})`
    lastIndex = match.index + match[0].length
    match = imagePattern.exec(markdown)
  }

  result += markdown.slice(lastIndex)
  return result
}

async function imageFileToDataUrl(imagePath: string, orgRoot: string) {
  if (!isInsideDirectory(orgRoot, imagePath)) return undefined

  let bytes: Buffer
  try {
    bytes = await readFile(imagePath)
  } catch {
    return undefined
  }

  return `data:${mimeTypeForPath(imagePath)};base64,${bytes.toString("base64")}`
}

function isRelativeImageSource(src: string) {
  return !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src)
}

function isInsideDirectory(parent: string, child: string) {
  const relativePath = relative(parent, child)
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.startsWith("/"))
  )
}

function mimeTypeForPath(path: string) {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".png":
      return "image/png"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    case ".svg":
      // Safe only because SVGs are rendered through <img>; do not inline as JSX.
      return "image/svg+xml"
    default:
      return "application/octet-stream"
  }
}

const markdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
      {children}
    </h2>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-6 text-base font-semibold text-slate-900 dark:text-slate-50">
      {children}
    </h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
      {children}
    </p>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mt-3 ml-5 max-w-3xl list-decimal space-y-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
      {children}
    </ol>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mt-3 ml-5 max-w-3xl list-disc space-y-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
      {children}
    </ul>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="pl-1">{children}</li>
  ),
  a: ({
    children,
    href,
  }: {
    children?: React.ReactNode
    href?: string | undefined
  }) => (
    <a
      href={href}
      className="font-medium text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
    >
      {children}
    </a>
  ),
  img: ({
    alt,
    src,
  }: {
    alt?: string | undefined
    src?: string | Blob | undefined
  }) => {
    if (typeof src !== "string" || src.length === 0) return null

    return (
      <span className="mt-4 block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <Image
          src={src}
          alt={alt ?? ""}
          width={1200}
          height={560}
          className="w-full"
          unoptimized={src.startsWith("data:")}
        />
      </span>
    )
  },
} satisfies Components

function urlTransform(url: string, key: string) {
  if (key === "src" && /^data:image\//i.test(url)) {
    return url
  }

  return defaultUrlTransform(url)
}
