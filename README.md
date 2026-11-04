<div align="center">

![Signals icon](./assets/icon.svg)

# Signals

![version](https://twexts.sdisk.us/api/v2/badge/@kamix/signals/version) ![downloads](https://twexts.sdisk.us/api/v2/badge/@kamix/signals/downloads) ![license](https://twexts.sdisk.us/api/v2/badge/@kamix/signals/license)

_Use inter-process communication in your TurboWarp projects._

</div>

## Highlights

- Communicate data and send events to different sprites without using complex broadcasting or variable systems.
- Opinionated. No need for configuration headaches.
- Register and unregister error types, like JavaScript. Let users know what went wrong.

## Overview

Signals is a TurboWarp extension that allows you to send and receive data and broadcasts between different sprites, and even the Stage. It has a custom error system with an error type (example: `SignalsError`) and a custom message, to let your users (and yourself) know what went wrong and why.

### Error state

Every `fire action`, `query` and `emit event` block starts by clearing the error
state, so `did error occur?`, `last error type` and `last error message` always
describe the most recent signal. A handler's `raise error` still counts: the
caller sees it once the signal returns. Use `clear error state` to reset the
state by hand at any point.

### Query timeouts

A query waits 2000 ms for a handler to return a value, then reports
`Query 'NAME' did not return a value within 2000 ms.` Use
`set query timeout (ms) [MS]` to change the wait, or set it to `0` to wait until
the handler returns.

### Events, actions and queries

`emit event` is a broadcast: every `when event ... emitted` hat in the project
runs for it, and they all read the same `signal data`. A hat that is still
running when an event arrives takes the emission as soon as its current script
ends — the emission waits in a queue instead of being dropped. `fire action`
and `query` go to exactly one handler — a second handler with the same name is
reported as an error instead of being silently ignored.

### Authors

> **AI DIsclosure:** AI was used in the development of Signals.

- **Lead Developer:** [@kamixfox](https://github.com/kamixfox)

## Installation

Since Signals must run unsandboxed, you can not import it from a URL. But, you can [download it from TwextHub](https://twexts.sdisk.us/ext/kamix/signals) and import it to TurboWarp.

## Feedback and Contributing

Discussions are turned off here, just open an issue if you have a question, or if you find a bug/a new feature to add.

If you want to contribute to this project, feel free! People like you make smaller projects like this thrive.
