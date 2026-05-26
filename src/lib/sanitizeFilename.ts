export function sanitizeFilename(filename: string) {
    // Replace unsafe Unicode characters and collapse spaces
    return filename
      .normalize('NFKD')                    // Decompose combined letters/accents
      .replace(/[^\p{ASCII}]/gu, '')        // Remove non-ASCII characters
      .replace(/\s+/g, '_');                // Replace spaces with underscores or dashes
  }
  
