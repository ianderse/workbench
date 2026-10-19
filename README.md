<p align="center">
  <picture class="github-only">
    <source media="(prefers-color-scheme: light)" srcset="./resources/assets/workbench-light.png">
    <source media="(prefers-color-scheme: dark)" srcset="./resources/assets/workbench-dark.png">
    <img alt="LangGraphics" src="./resources/assets/workbench-dark.png" width="150px">
  </picture>
</p>

**Workbench** is a desktop app built on the Claude Code harness for proactive engineers. It gives you a workspace to
manage your project tasks and hand each one to an agent that works in its own git worktree, so your main branch stays
untouched until you review and merge.

<p align="center">
  <picture class="github-only">
    <source media="(prefers-color-scheme: light)" srcset="./resources/assets/kanban-light.png">
    <source media="(prefers-color-scheme: dark)" srcset="./resources/assets/kanban-dark.png">
    <img alt="Kanban" src="./resources/assets/kanban-dark.png" width="800px">
  </picture>
</p>

Workbench also improves itself as you work, saving the preferences it picks up from your sessions so the next one starts
where the last left off: compounding engineering, built in. You become the architect/manager of your project: you set
the direction and the priorities, the agents do the work, and nothing lands until you have reviewed it.

<p align="center">
  <picture class="github-only">
    <source media="(prefers-color-scheme: light)" srcset="./resources/assets/graph-light.png">
    <source media="(prefers-color-scheme: dark)" srcset="./resources/assets/graph-dark.png">
    <img alt="Graph" src="./resources/assets/graph-dark.png" width="800px">
  </picture>
</p>

## Motivation

I always come up with new project ideas, inspired by a YouTube video, a Reddit post, or somewhere else, and most of them
die in my Obsidian vault because I don't have the time to spend on implementing them. I needed an app like Workbench,
where I could open my ideas as projects and let the agents build MVPs while I was working on my daily tasks. I used a
couple of similar projects previously, but they all try to implement their agent harness from scratch that underperforms
Claude Code in result quality and performance.

<p align="center">
  <picture class="github-only">
    <source media="(prefers-color-scheme: light)" srcset="./resources/assets/agents-light.png">
    <source media="(prefers-color-scheme: dark)" srcset="./resources/assets/agents-dark.png">
    <img alt="Agents" src="./resources/assets/agents-dark.png" width="800px">
  </picture>
</p>

Why reinvent something that already works perfectly? Workbench relies on Claude Code's harness, bringing the parts that
already work (worktree isolation, planning and validation, subagents, skills, MCP connectors) together into one app, so
the whole experience is in one place.

## Contribute

While pull requests are temporarily not accepted, all other kinds of contributions such as opening
an [issue](https://github.com/proactive-agent/workbench/issues),
creating [discussions](https://github.com/proactive-agent/workbench/discussions), suggesting a new feature or an
improvement is welcome.

## License

Copyright (C) 2026 Artyom Vancyan. [MIT](./LICENSE)
