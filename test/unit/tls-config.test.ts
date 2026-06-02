import { describe, test, expect, afterEach } from "bun:test"
import { getTlsConfig } from "../../src/tls-config"
import fs from "node:fs"
import path from "node:path"

describe("tls-config", () => {
  const originalNodeTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const originalEasycodeTls = process.env.EASYCODE_REJECT_UNAUTHORIZED
  const originalExtraCa = process.env.NODE_EXTRA_CA_CERTS

  afterEach(() => {
    if (originalNodeTls === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalNodeTls
    }

    if (originalEasycodeTls === undefined) {
      delete process.env.EASYCODE_REJECT_UNAUTHORIZED
    } else {
      process.env.EASYCODE_REJECT_UNAUTHORIZED = originalEasycodeTls
    }

    if (originalExtraCa === undefined) {
      delete process.env.NODE_EXTRA_CA_CERTS
    } else {
      process.env.NODE_EXTRA_CA_CERTS = originalExtraCa
    }
  })

  test("returns undefined when no env is set", () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    delete process.env.EASYCODE_REJECT_UNAUTHORIZED
    delete process.env.NODE_EXTRA_CA_CERTS
    expect(getTlsConfig()).toBeUndefined()
  })

  test("respects NODE_TLS_REJECT_UNAUTHORIZED=0", () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    delete process.env.EASYCODE_REJECT_UNAUTHORIZED
    expect(getTlsConfig()).toEqual({ rejectUnauthorized: false })
  })

  test("respects EASYCODE_REJECT_UNAUTHORIZED=0", () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.EASYCODE_REJECT_UNAUTHORIZED = "0"
    expect(getTlsConfig()).toEqual({ rejectUnauthorized: false })
  })

  test("ignores non-existent ca cert file", () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    delete process.env.EASYCODE_REJECT_UNAUTHORIZED
    process.env.NODE_EXTRA_CA_CERTS = "/nonexistent/ca-cert.pem"
    expect(getTlsConfig()).toBeUndefined()
  })

  test("reads and sets custom CA certificate file if it exists", () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    delete process.env.EASYCODE_REJECT_UNAUTHORIZED
    
    const tempCertPath = path.join(__dirname, "temp-test-cert.pem")
    fs.writeFileSync(tempCertPath, "test-ca-cert-content")
    
    try {
      process.env.NODE_EXTRA_CA_CERTS = tempCertPath
      const config = getTlsConfig()
      expect(config).toBeDefined()
      expect(config?.ca).toBeDefined()
    } finally {
      try {
        fs.unlinkSync(tempCertPath)
      } catch {}
    }
  })
})
