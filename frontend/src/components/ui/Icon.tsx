import type { SVGProps } from 'react';
const paths = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  plus: 'M12 5v14 M5 12h14', minus: 'M5 12h14', play: 'M8 5l11 7-11 7z', close: 'M6 6l12 12 M18 6L6 18',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  link: 'M10 13a5 5 0 0 0 7 0l4-4a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-4 4a5 5 0 0 0 7 7l2-2',
  folder: 'M3 5h6l2 2h10v13H3z', box: 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 5 9-5 M12 12v9',
  book: 'M12 5v16 M12 5C8 2 4 3 2 4v15c4-2 7-1 10 2 3-3 6-4 10-2V4c-2-1-6-2-10 1',
  panel: 'M3 4h18v16H3z M15 4v16 M17 8h2 M17 12h2', moon: 'M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
  reset: 'M3 11a9 9 0 1 1 2 7 M3 3v8h8', chart: 'M3 3v18h18 M7 15l5-7 4 4 5-7',
  check: 'M5 12l4 4L20 5', alert: 'M12 3L2 21h20z M12 9v5 M12 17v1', chevron: 'M9 5l7 7-7 7'
};
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}
