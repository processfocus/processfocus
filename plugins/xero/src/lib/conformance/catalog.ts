/**
 * Pre-provisioned Demo Company catalog Items used by conformance scenarios.
 *
 * These ItemCodes are not created by the plugin. Operators create them once
 * in the dedicated NZ Demo Company. Override with XERO_DEMO_ZERO_ITEM and
 * XERO_DEMO_GST_ITEM when a tenant already uses different codes.
 */
const DEFAULT_ZERO_TAX_ITEM_CODE = "PF-ZERO"
const DEFAULT_GST_ITEM_CODE = "PF-GST15"

export const CONFORMANCE_AGREED_PRICE = "100.00"
export const CONFORMANCE_ZERO_TAX = "0.00"
export const CONFORMANCE_GST_TAX = "13.04"
export const CONFORMANCE_CURRENCY = "NZD"
export const CONFORMANCE_SHIPPING_LINE1 = "CANARY-SHIPPING-LINE-1"

export const catalogItemCodes = (): {
  readonly zeroTax: string
  readonly gst: string
} => ({
  zeroTax:
    process.env["XERO_DEMO_ZERO_ITEM"]?.trim() || DEFAULT_ZERO_TAX_ITEM_CODE,
  gst: process.env["XERO_DEMO_GST_ITEM"]?.trim() || DEFAULT_GST_ITEM_CODE,
})
