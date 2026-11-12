/**
 * Decide whether protect-by-default may touch the current user's tool configs.
 *
 * Normal launches run it. Isolated profiles (tests, portable runs that point
 * NETWORK_LENS_DATA_DIR elsewhere) must opt in explicitly, because they often
 * share the real home directory and would otherwise rewrite real tool configs.
 */
export function autoProtectAllowed(
  env: Record<string, string | undefined>,
): boolean {
  if (env.NETWORK_LENS_AUTO_PROTECT === "1") return true;
  if (env.NETWORK_LENS_AUTO_PROTECT === "0") return false;
  if (env.NETWORK_LENS_NO_AUTO_PROTECT === "1") return false;
  return !env.NETWORK_LENS_DATA_DIR;
}
