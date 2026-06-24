const logoMap = {
  horizontal: {
    blue: { standard: '/logos/GENIUS_SPORTS_HORIZONTAL_BLUE_RGB.svg', small: '/logos/GENIUS_SPORTS_HORIZONTAL_BLUE_RGB.svg' },
    white: { standard: '/logos/GENIUS_SPORTS_HORIZONTAL_WHITE_RGB.svg', small: '/logos/GENIUS_SPORTS_HORIZONTAL_WHITE_RGB.svg' },
  },
  vertical: {
    blue: { standard: '/logos/GENIUS_SPORTS_VERTICAL_BLUE_RGB.svg', small: '/logos/GENIUS_SPORTS_VERTICAL_BLUE_RGB.svg' },
    white: { standard: '/logos/GENIUS_SPORTS_VERTICAL_WHITE_RGB.svg', small: '/logos/GENIUS_SPORTS_VERTICAL_WHITE_RGB.svg' },
  },
  wordmark: {
    blue: { standard: '/logos/GENIUS_SPORTS_WORDMARK_BLUE_RGB.svg', small: '/logos/GENIUS_SPORTS_WORDMARK_BLUE_RGB.svg' },
    white: { standard: '/logos/GENIUS_SPORTS_WORDMARK_WHITE_RGB.svg', small: '/logos/GENIUS_SPORTS_WORDMARK_WHITE_RGB.svg' },
  },
  marque: {
    blue: { standard: '/logos/GENIUS_SPORTS_MARQUE_BLUE_RGB.svg', small: '/logos/GENIUS_SPORTS_MARQUE_BLUE_RGB.svg' },
    white: { standard: '/logos/GENIUS_SPORTS_MARQUE_WHITE_RGB.svg', small: '/logos/GENIUS_SPORTS_MARQUE_WHITE_RGB.svg' },
  },
}

const minWidths = {
  vertical: 110,
  horizontal: 70,
  wordmark: 70,
  marque: 40,
}

export default function Logo({
  variant = 'horizontal',
  color = 'white',
  size = 'standard',
  className = '',
  alt = 'Genius Sports',
}) {
  const src = logoMap[variant][color][size]
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={{ minWidth: minWidths[variant] }}
    />
  )
}
