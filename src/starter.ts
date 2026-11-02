export const STARTER = `# yaml-language-server: $schema=https://unpkg.com/uat-reel/schema.json
title: Feature name
description: One line on what this UAT proves.
baseUrl: http://localhost:3000

acceptance:
  - id: AC1
    text: A user can do the thing

scenes:
  - id: do-the-thing
    title: Do the thing
    covers: [AC1]
    steps:
      - goto: /
        say: The user starts on the home page.
      - click: role=button[name="Do the thing"]
        box: Do the thing
        say: They start the thing.
      - expect: role=status
        text: Done
        box: Confirmation
        say: The app confirms it is done.
`;
