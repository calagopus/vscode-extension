import type { ArchiveFormat } from '../api/types.ts';

export const ARCHIVE_FORMATS: { format: ArchiveFormat; extension: string }[] = [
  { format: 'tar_gz', extension: '.tar.gz' },
  { format: 'zip', extension: '.zip' },
  { format: 'tar', extension: '.tar' },
  { format: 'tar_xz', extension: '.tar.xz' },
  { format: 'tar_lzip', extension: '.tar.lz' },
  { format: 'tar_bz2', extension: '.tar.bz2' },
  { format: 'tar_lz4', extension: '.tar.lz4' },
  { format: 'tar_zstd', extension: '.tar.zst' },
  { format: 'seven_zip', extension: '.7z' },
];

export function generateArchiveName(extension: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('');
  return `archive-${stamp}${extension}`;
}
