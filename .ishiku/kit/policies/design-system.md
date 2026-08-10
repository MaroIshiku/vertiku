# ishiku design system

The family is friendly, minimal, modern, mobile-first, and accessible: Material 3 Expressive geometry with a subtle pixel accent. All interface text is English.

Use semantic tokens, never feature-level hard-coded colors or spacing. The six themes are `violet`, `ocean`, `forest`, `sunset`, `rose`, and `mono`; each supplies light and dark color roles. Core spacing is 4/8/12/16/24/32/48 px; radii are 8/12/16/24 px; motion is 120/200/300 ms and respects reduced motion. Breakpoints are 600, 840, 1200, and 1600 px.

The header shows logo, app name, and subtitle at left and an accessible profile button at right. The profile menu consistently exposes Profile, Settings, Theme, and About. Reuse one component contract for buttons, fields, cards, tables, navigation, dialogs, toasts, loading, empty, error, warning, and success states.

Meet WCAG 2.2 AA: semantic structure, visible focus, complete keyboard use, labeled icons, adequate targets and contrast, announcements for asynchronous states, and no color-only meaning. Prevent clipped text and horizontal page scrolling.

Visual and accessibility coverage includes 390×844, 412×915, 768×1024, 1440×900, and 1920×1080; light and dark; all six themes; long English strings; loading/error/empty states; dialogs; and mobile/desktop navigation. Baselines require human approval and must not auto-update in CI.
