/**
 * Moves parts of the page (index.html: the filter section, job progress, details editors) into
 * the shell's containers while they are shown, and puts them back where they were when they go.
 * The old screens draw into those parts with React portals, which follow the moved element.
 */
import { useLayoutEffect } from 'react';

/** Put the first element matching `selector` into `container`; returns how to put it back. */
export function adopt(selector: string, container: HTMLElement): (() => void) | null {
  const node = document.querySelector(selector);
  const parent = node?.parentNode;
  if (!node || !parent || container.contains(node)) return null;
  const marker = document.createComment(`jp-adopted ${selector}`);
  parent.insertBefore(marker, node);
  container.appendChild(node);
  return () => {
    if (marker.parentNode) {
      marker.parentNode.insertBefore(node, marker);
      marker.remove();
    }
  };
}

/** adopt() for as long as the component is mounted and the container exists. */
export function useAdopt(selector: string, container: HTMLElement | null) {
  useLayoutEffect(() => (container ? (adopt(selector, container) ?? undefined) : undefined), [selector, container]);
}
