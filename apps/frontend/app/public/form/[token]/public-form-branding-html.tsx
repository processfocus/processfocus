"use client"

import { useEffect, useRef } from "react"

const activateScripts = (root: HTMLElement | null): void => {
  if (!root) {
    return
  }

  for (const script of root.querySelectorAll("script")) {
    const replacement = document.createElement("script")

    for (const attribute of script.attributes) {
      replacement.setAttribute(attribute.name, attribute.value)
    }

    replacement.text = script.text
    script.replaceWith(replacement)
  }
}

export const PublicFormBrandingHtml = ({ html }: { readonly html: string }) => {
  const ref = useRef<HTMLDivElement>(null)
  const activatedHtmlRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    // React Strict Mode can mount effects twice; avoid re-running trusted scripts.
    if (activatedHtmlRef.current === html) {
      return
    }

    activateScripts(ref.current)
    activatedHtmlRef.current = html
  }, [html])

  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: public form branding is trusted deploy-time organisation HTML.
    <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
  )
}
