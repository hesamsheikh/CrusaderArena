# Crusader Arena documentation

[← Project overview](../README.md)

Start with **How it works**, then read whichever part you need.

| Page | Read it to learn |
| --- | --- |
| [How it works](how-it-works.md) | The pieces, and one run from start to finish |
| [The benchmark](benchmark.md) | What is measured, scoring, running episodes and comparing runs |
| [The agent](agent.md) | How the model plays: turns, rules, memory, failure handling |
| [Context](context.md) | Exactly what the model is sent, and how the context stays within budget |
| [Tool reference](tools.md) | Every tool: parameters, behaviour and results |
| [The harness](harness.md) | Using the dashboard, model profiles, run files, videos, safety boundaries |
| [Publishing runs](publishing.md) | Packaging runs, scrubbing them and uploading them to the Hugging Face dataset |
| [Setup](setup.md) | Installing the game machine and the host |
| [The reader](reader.md) | How game state is read, what it contains and its limits |
| [Status](status.md) | What is verified, what is not, and known issues |
| [Roadmap](../ROADMAP.md) | What is planned next |

The prompts the model receives are in [`prompt/`](../prompt): the controls guide,
the game reference and the benchmark rules.
