type AssistantErrorCopy = {
  certificateIssueDetail: string
  certificateIssueTitle: string
  runFailed: string
  runFailedHint: string
}

export function assistantErrorPresentation(text: string, copy: AssistantErrorCopy) {
  const compact = text.trim().replace(/\s+/g, " ")
  const isRunFailure = /\brun failed\b/i.test(compact)
  const isCertificateFailure = /unable to get local issuer certificate/i.test(compact)
  if (!isRunFailure && !isCertificateFailure) return undefined
  if (isCertificateFailure) {
    return { title: copy.certificateIssueTitle, detail: copy.certificateIssueDetail, hint: copy.runFailedHint }
  }
  const detail = compact.replace(/\s*Run failed\..*$/i, "").trim() || copy.runFailed
  return { title: copy.runFailed, detail, hint: copy.runFailedHint }
}

