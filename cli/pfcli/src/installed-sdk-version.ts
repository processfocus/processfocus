import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const hasIntegrity = (value: unknown): boolean =>
  typeof value === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value)

const lockPath = (from: string, to: string): string =>
  relative(from, to).split(sep).join("/")

function pnpmRegistryInstall({
  lock,
  root,
  orgPath,
  installedPath,
  version,
  tarball,
}: {
  lock: unknown
  root: string
  orgPath: string
  installedPath: string
  version: string
  tarball: string
}): boolean {
  const packageId = `processfocus@${version}`
  if (!isRecord(lock) || !isRecord(lock["packages"])) return false
  const entry = lock["packages"][packageId]
  const resolution = isRecord(entry) ? entry["resolution"] : undefined
  if (
    !isRecord(resolution) ||
    !hasIntegrity(resolution["integrity"]) ||
    (resolution["tarball"] !== undefined && resolution["tarball"] !== tarball)
  )
    return false

  const isolated =
    /^node_modules\/\.pnpm\/([^/]+)\/node_modules\/processfocus$/.exec(
      installedPath,
    )?.[1]
  if (isolated === packageId || isolated?.startsWith(`${packageId}_`))
    return true

  // Hoisted registry packages and tarballs have the same on-disk path.
  // Use the importing project's installed resolution to distinguish them.
  const importers = lock["importers"]
  if (!isRecord(importers)) return false
  for (let dir = orgPath; ; dir = dirname(dir)) {
    const importer = importers[lockPath(root, dir) || "."]
    if (isRecord(importer)) {
      if (
        installedPath !== "node_modules/processfocus" &&
        installedPath !==
          lockPath(root, resolve(dir, "node_modules/processfocus"))
      )
        return false
      return dependencySections.some((section) => {
        const dependencies = importer[section]
        const dependency = isRecord(dependencies)
          ? dependencies["processfocus"]
          : undefined
        const resolved = isRecord(dependency)
          ? dependency["version"]
          : undefined
        return (
          typeof resolved === "string" &&
          (resolved === version || resolved.startsWith(`${version}(`))
        )
      })
    }
    if (dir === root) return false
  }
}

function yarnClassicRegistryInstall(
  metadata: unknown,
  tarball: string,
): boolean {
  if (!isRecord(metadata)) return false
  const patterns = metadata["topLevelPatterns"]
  const entries = metadata["lockfileEntries"]
  if (!Array.isArray(patterns) || !isRecord(entries)) return false

  const sdkPatterns = patterns.filter(
    (pattern): pattern is string =>
      typeof pattern === "string" && pattern.startsWith("processfocus@"),
  )
  const yarnTarball = tarball.replace(
    "https://registry.npmjs.org/",
    "https://registry.yarnpkg.com/",
  )
  return (
    sdkPatterns.length > 0 &&
    sdkPatterns.every((pattern) => {
      const resolved = entries[pattern]
      if (typeof resolved !== "string") return false
      // Yarn Classic appends the tarball's SHA-1 as a URL fragment.
      const [url] = resolved.split("#", 1)
      return url === tarball || url === yarnTarball
    })
  )
}

function yarnRegistryInstall(
  state: unknown,
  installedPath: string,
  version: string,
): boolean {
  if (!isRecord(state)) return false
  const matches = Object.entries(state).filter(
    ([, entry]) =>
      isRecord(entry) &&
      Array.isArray(entry["locations"]) &&
      entry["locations"].includes(installedPath),
  )
  if (matches.length !== 1) return false
  // Yarn virtualizes packages with peer dependencies. The locator after the
  // virtual prefix still records whether the installed package came from npm.
  const locator = matches[0]?.[0].replace(
    /^processfocus@virtual:[^#]+#/,
    "processfocus@",
  )
  return locator === `processfocus@npm:${version}`
}

function npmRegistryInstall(
  lock: unknown,
  installedPath: string,
  version: string,
  tarball: string,
): boolean {
  if (!installedPath.endsWith("node_modules/processfocus")) return false
  const entry =
    isRecord(lock) && isRecord(lock["packages"])
      ? lock["packages"][installedPath]
      : undefined
  return (
    isRecord(entry) &&
    entry["version"] === version &&
    entry["resolved"] === tarball &&
    hasIntegrity(entry["integrity"])
  )
}

function declaresLocalSdk(manifestPath: string): boolean {
  if (!existsSync(manifestPath)) return false
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (!isRecord(manifest)) return false
  return dependencySections.some((section) => {
    const dependencies = manifest[section]
    const spec = isRecord(dependencies)
      ? dependencies["processfocus"]
      : undefined
    return (
      typeof spec === "string" &&
      /^(?:(?:file|link|portal|workspace):|\.{1,2}[\\/]|[\\/])/.test(spec)
    )
  })
}

// Directory names and package.json alone cannot distinguish npm installs from
// packed rehearsal artifacts. Check the frozen resolution for the installed SDK.
export function installedSdkVersion(orgPath: string): string | undefined {
  let manifestPath: string
  try {
    manifestPath = realpathSync(
      Bun.resolveSync("processfocus/package.json", orgPath),
    )
  } catch {
    return undefined
  }
  const sdk: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (
    !isRecord(sdk) ||
    sdk["name"] !== "processfocus" ||
    typeof sdk["version"] !== "string"
  )
    return undefined

  const version = sdk["version"]
  const tarball = `https://registry.npmjs.org/processfocus/-/processfocus-${version}.tgz`
  const orgRoot = realpathSync(orgPath)
  for (let dir = orgRoot; ; dir = dirname(dir)) {
    const installedPath = lockPath(dir, dirname(manifestPath))
    // A local declaration rules out automatic release selection even if
    // another package manager left a registry record for the same version.
    if (declaresLocalSdk(resolve(dir, "package.json"))) return undefined
    // pnpm's virtual-store lock records what was installed, even if the
    // project lockfile has since been edited.
    const pnpmLock = resolve(dir, "node_modules/.pnpm/lock.yaml")
    const yarnState = resolve(dir, "node_modules/.yarn-state.yml")
    const yarnIntegrity = resolve(dir, "node_modules/.yarn-integrity")
    const installedNpmLock = resolve(dir, "node_modules/.package-lock.json")
    const bunLock = resolve(dir, "bun.lock")
    const npmLock = resolve(dir, "package-lock.json")
    // npm can replace a pnpm symlink with a hoisted package while leaving
    // the virtual store intact. Prefer npm's record for that exact path.
    if (existsSync(installedNpmLock)) {
      const lock: unknown = JSON.parse(readFileSync(installedNpmLock, "utf8"))
      if (
        isRecord(lock) &&
        isRecord(lock["packages"]) &&
        Object.hasOwn(lock["packages"], installedPath)
      )
        return npmRegistryInstall(lock, installedPath, version, tarball)
          ? version
          : undefined
    }
    if (existsSync(pnpmLock)) {
      return pnpmRegistryInstall({
        lock: Bun.YAML.parse(readFileSync(pnpmLock, "utf8")),
        root: dir,
        orgPath: orgRoot,
        installedPath,
        version,
        tarball,
      })
        ? version
        : undefined
    }
    // Installed Yarn metadata takes precedence over checked-in lockfiles.
    if (existsSync(yarnState)) {
      return yarnRegistryInstall(
        Bun.YAML.parse(readFileSync(yarnState, "utf8")),
        installedPath,
        version,
      )
        ? version
        : undefined
    }
    if (existsSync(yarnIntegrity)) {
      return installedPath === "node_modules/processfocus" &&
        yarnClassicRegistryInstall(
          JSON.parse(readFileSync(yarnIntegrity, "utf8")),
          tarball,
        )
        ? version
        : undefined
    }
    if (existsSync(bunLock)) {
      const isolated =
        /^node_modules\/\.bun\/([^/]+)\/node_modules\/processfocus$/.exec(
          installedPath,
        )?.[1]
      const registryDirectory = `processfocus@${version}`
      if (
        installedPath !== "node_modules/processfocus" &&
        isolated !== registryDirectory &&
        !isolated?.startsWith(`${registryDirectory}+`)
      )
        return undefined

      const lock: unknown = Bun.JSONC.parse(readFileSync(bunLock, "utf8"))
      const entry =
        isRecord(lock) && isRecord(lock["packages"])
          ? lock["packages"]["processfocus"]
          : undefined
      return Array.isArray(entry) &&
        entry[0] === `processfocus@${version}` &&
        (entry[1] === "" || entry[1] === tarball) &&
        hasIntegrity(entry[3])
        ? version
        : undefined
    }
    if (existsSync(npmLock)) {
      return npmRegistryInstall(
        JSON.parse(readFileSync(npmLock, "utf8")),
        installedPath,
        version,
        tarball,
      )
        ? version
        : undefined
    }
    if (dirname(dir) === dir) return undefined
  }
}
