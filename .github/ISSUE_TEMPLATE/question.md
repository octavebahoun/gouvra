---
name: Question
description: Ask a question about Gouvra
title: "[Question]: "
labels: ["question"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for reaching out. Please provide enough context so we can give you a helpful answer.

  - type: textarea
    id: question
    attributes:
      label: Your question
      description: What would you like to know about Gouvra?
      placeholder: How can I ...
    validations:
      required: true

  - type: textarea
    id: context
    attributes:
      label: Context
      description: Any detail that helps us understand (what you're trying to do, what you've tried so far).
    validations:
      required: false

  - type: input
    id: version
    attributes:
      label: Gouvra version or commit
      placeholder: e.g. 0.3.1 or 9df45eb
    validations:
      required: false

  - type: checkboxes
    id: checks
    attributes:
      label: Checklist
      options:
        - label: I searched existing issues and found no duplicate.
          required: true
