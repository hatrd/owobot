const HOME_PATH_PREFIX_RE = /\/home\/[^/\s]+\/?/g

function sanitizeOutboundText (value) {
  const text = value == null ? '' : String(value)
  if (!text || !text.includes('/home/')) return text
  return text.replace(HOME_PATH_PREFIX_RE, '')
}

module.exports = {
  sanitizeOutboundText
}
