/** Remove transport details while preserving the operation's actionable reason. */
export function operationError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
}
