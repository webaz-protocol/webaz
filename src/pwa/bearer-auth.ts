export function readStrictBearerCredential(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer ([^\s]+)$/)
  return match?.[1]
}

export function hasInvalidPurchaseCredential(
  authorization: string | undefined,
  bodyApiKey: unknown,
  credential: string | undefined,
): boolean {
  return bodyApiKey !== undefined || (!!authorization && !credential)
}
