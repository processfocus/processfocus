"use client"

import { QRCodeSVG } from "qrcode.react"
import { useState } from "react"
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@pf/shadcn-components"
import { CopyButton } from "@/components/copy-button"

/** Only rendered from the caller's authorized List metadata. */
export function AnonymousPageLink({
  name,
  path,
}: {
  name: string
  path: string
}) {
  const [address, setAddress] = useState<string | null>(null)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAddress(new URL(path, window.location.origin).href)}
        >
          {name} page QR code
        </Button>
      </PopoverTrigger>
      {address ? (
        <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] space-y-4 p-4">
          <QRCodeSVG
            value={address}
            size={192}
            title={`${name} page`}
            className="mx-auto h-auto max-w-full"
          />
          <div className="flex items-center gap-2">
            <a
              href={address}
              target="_blank"
              rel="noreferrer"
              title={address}
              className="min-w-0 flex-1 truncate underline"
            >
              {address}
            </a>
            <CopyButton value={address} label={`Copy ${name} page URL`} />
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}
