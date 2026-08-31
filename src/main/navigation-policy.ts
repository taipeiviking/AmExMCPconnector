/** Renderer content never chooses an external destination. Fixed documentation
 * links are opened only by allowlisted main-process actions. */
export function isRendererWindowOpenAllowed(_url: string): boolean {
  return false;
}
