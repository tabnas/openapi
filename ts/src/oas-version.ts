/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The OpenAPI or Swagger version a description names. Its own module so
// that both `parse` and `resolve` can read it.

function isMap(value: unknown): value is Record<string, unknown> {
  return null != value && 'object' === typeof value && !Array.isArray(value)
}

// The OpenAPI or Swagger version a tree's root names.
type VersionInfo = {
  // The version, to its minor: '2.0' for Swagger, '3.0', '3.1' or '3.2'
  // for OpenAPI, and 'unknown' for anything else.
  version: '2.0' | '3.0' | '3.1' | '3.2' | 'unknown'
  // The member the version came from, `openapi` taking precedence, or
  // null when the root has neither.
  field: 'openapi' | 'swagger' | null
  // That member's value, as written.
  value: unknown
}

const OPENAPI_VERSION = /^3\.([0-2])(?:\.\d+)?(?:[-+][0-9A-Za-z.-]*)?$/
const SWAGGER_VERSION = /^2\.0(?:\.\d+)?$/

// Read the version from a tree's root, leniently: a string or a number, as
// YAML may have read an unquoted `3.1` or `2.0`.
function version(tree: unknown): VersionInfo {
  if (!isMap(tree)) {
    return { version: 'unknown', field: null, value: undefined }
  }
  const own = (name: string) => Object.prototype.hasOwnProperty.call(tree, name)
  if (own('openapi')) {
    const value = tree.openapi
    let minor: string | null = null
    if ('string' === typeof value) {
      const m = OPENAPI_VERSION.exec(value)
      minor = null == m ? null : m[1]
    } else if (3 === value) {
      minor = '0'
    } else if (3.1 === value) {
      minor = '1'
    } else if (3.2 === value) {
      minor = '2'
    }
    return {
      version: null == minor ? 'unknown' : (('3.' + minor) as VersionInfo['version']),
      field: 'openapi',
      value,
    }
  }
  if (own('swagger')) {
    const value = tree.swagger
    const known =
      ('string' === typeof value && SWAGGER_VERSION.test(value)) || 2 === value
    return { version: known ? '2.0' : 'unknown', field: 'swagger', value }
  }
  return { version: 'unknown', field: null, value: undefined }
}

export { version }

export type { VersionInfo }
