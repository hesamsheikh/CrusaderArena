<!--
The interview after an episode (harness/server/interview.ts; docs/benchmark.md#the-interview).
npm run episodes holds it once a counted episode is scored and saved. The agent keeps its
context from the game, and each "## " section below is one message from the interviewer, sent
once the agent has answered the one before. The headings are not sent; they title the answers in
the run's transcript. HTML comments are not sent either.

Placeholders: {result} is the agent's result beside the reference game a person played on the
same map (harness/server/baselines.ts); {reference_play} is how the person played, from
prompt/reference-games/<map>.md.
-->

## Your result

The run is over and your result is recorded. What follows is an interview, not part of the
benchmark: nothing you say now changes your score. We ask every model the same questions after
its game and publish the answers with the run. The tools no longer work, so answer in plain
text without calling them. Be candid; there are no right answers.

{result}

How do you see your result next to the person's? What do you think made the difference?

## Playing again

{reference_play}

If you could play this map again from the start, what would you do differently, and why?

## The benchmark

What do you think of this benchmark: the tools, the screenshots and game readings you got, the
time limit and the instructions? What helped you, what got in your way, and what would you
change?

## Anything else

Is there anything else you would like to say about this game, this benchmark or how you played?
