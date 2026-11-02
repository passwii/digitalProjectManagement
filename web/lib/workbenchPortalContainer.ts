const CONSOLE_SHELL_SELECTOR = '[data-console-shell="true"]';

export function getWorkbenchPortalContainer(): HTMLElement {
  return document.querySelector<HTMLElement>(CONSOLE_SHELL_SELECTOR) ?? document.body;
}
