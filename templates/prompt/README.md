# Prompt app template — Launch Copy

`type: prompt` apps contain skills/templates only (Markdown files). Nothing runs on a server.
Published prompt apps are exported to the AIX **Claude Code plugin marketplace**, so users can
`/plugin marketplace add` it and install the skills.

```bash
aix app init my-skills --template prompt
aix app validate && aix app publish
```
List every skill file in `aix.json → skills`.
