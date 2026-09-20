// biome-ignore-all lint/suspicious/noExplicitAny: legacy code
declare module "*.svg" {
  const content: any
  export const ReactComponent: any
  export default content
}

declare module "*.css"

declare module "@xyflow/react/dist/style.css"

declare module "server-only"
