import fs from "node:fs"

export interface TlsConfig {
  rejectUnauthorized?: boolean
  ca?: unknown
}

export function getTlsConfig(): TlsConfig | undefined {
  const config: TlsConfig = {}
  let hasConfig = false

  if (
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    process.env.EASYCODE_REJECT_UNAUTHORIZED === "0"
  ) {
    config.rejectUnauthorized = false
    hasConfig = true
  }

  const extraCaCerts = process.env.NODE_EXTRA_CA_CERTS || process.env.EASYCODE_EXTRA_CA_CERTS
  if (extraCaCerts) {
    try {
      if (fs.existsSync(extraCaCerts)) {
        if (typeof Bun !== "undefined") {
          config.ca = Bun.file(extraCaCerts)
        } else {
          config.ca = fs.readFileSync(extraCaCerts, "utf8")
        }
        hasConfig = true
      }
    } catch {
      // Ignore filesystem check errors
    }
  }

  return hasConfig ? config : undefined
}
