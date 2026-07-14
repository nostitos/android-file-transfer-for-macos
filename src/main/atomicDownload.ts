import { existsSync, linkSync, lstatSync, unlinkSync } from 'node:fs';

export interface PublishTemporaryFileOptions {
  temporaryPath: string;
  destinationPath: string;
  expectedSize: number;
  allowExistingEquivalent?: boolean;
  onCollision?: (currentPath: string) => string;
}

export interface PublishedTemporaryFile {
  destinationPath: string;
  size: number;
  usedExisting: boolean;
}

export function publishTemporaryFile(
  options: PublishTemporaryFileOptions
): PublishedTemporaryFile {
  const temporaryStat = lstatSync(options.temporaryPath);
  if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()) {
    throw new Error('The downloaded temporary item is not a regular file.');
  }
  if (options.expectedSize > 0 && temporaryStat.size !== options.expectedSize) {
    throw new Error(
      `The phone sent ${temporaryStat.size} bytes, but ${options.expectedSize} bytes were expected.`
    );
  }

  let destinationPath = options.destinationPath;
  while (true) {
    if (existsSync(destinationPath)) {
      if (options.allowExistingEquivalent) {
        const existingStat = lstatSync(destinationPath);
        if (
          existingStat.isFile() &&
          !existingStat.isSymbolicLink() &&
          existingStat.size === temporaryStat.size
        ) {
          unlinkSync(options.temporaryPath);
          return { destinationPath, size: temporaryStat.size, usedExisting: true };
        }
      }
      if (!options.onCollision) {
        throw new Error(`A different item already exists at ${destinationPath}.`);
      }
      destinationPath = options.onCollision(destinationPath);
      continue;
    }

    try {
      linkSync(options.temporaryPath, destinationPath);
      try {
        unlinkSync(options.temporaryPath);
      } catch (error) {
        unlinkSync(destinationPath);
        throw error;
      }
      return { destinationPath, size: temporaryStat.size, usedExisting: false };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'EEXIST' || !options.onCollision) {
        throw error;
      }
      destinationPath = options.onCollision(destinationPath);
    }
  }
}
