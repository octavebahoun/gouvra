---
name: Bug report
description: Report something that is broken or behaving unexpectedly in Gouvra
title: "[Bug]: "
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to report a bug. Please fill in as much detail as you can.

  - type: textarea
    id: description
    attributes:
      label: What happened?
      description: A clear and concise description of the bug.
      placeholder: When I ran ..., Gouvra returned ...
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: What did you expect to happen?
      placeholder: I expected the cost to be shown instead of "unavailable".
    validations:
      required: true

  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      placeholder: |
        1. ...
        2. ...
        3. ...
    validations:
      required: true

  - type: input
    id: version
    attributes:
      label: Gouvra version or commit
      placeholder: e.g. 0.3.1 or 9df45eb
    validations:
      required: false

  - type: dropdown
    id: provider
    attributes:
      label: Provider involved (if any)
      options:
        - Not applicable / unknown
        - OpenAI
        - Anthropic
        - Gemini
        - Mistral
        - Groq
        - Together AI
        - Other
    validations:
      required: false

  - type: input
    id: python
    attributes:
      label: Python version
      placeholder: e.g. 3.12.4
    validations:
      required: false

  - type: dropdown
    id: os
    attributes:
      label: Operating system
      options:
        - Linux
        - macOS
        - Windows
        - Other
    validations:
      required: false

  - type: textarea
    id: logs
    attributes:
      label: Error output or traceback
      description: Paste any relevant logs. Remove secrets and API keys first.
      render: shell
    validations:
      required: false

  - type: textarea
    id: context
    attributes:
      label: Additional context
      description: Anything else that might help.
    validations:
      required: false

  - type: checkboxes
    id: checks
    attributes:
      label: Checklist
      options:
        - label: I searched existing issues and found no duplicate.
          required: true
        - label: I removed any API keys or personal data from the logs.
          required: true
