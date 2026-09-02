# Third-Party Notices

## Development dependency

| Package | Locked version | Declared license | Use |
|---|---:|---|---|
| `@yodaos-pkg/aix-cli` | 0.8.2 | MIT | Local AIX preview and package inspection |
| `ignore` | 5.3.2 | MIT | Transitive development dependency |
| `ws` | 8.21.3 | MIT | Transitive development dependency |

`node_modules/` is excluded from source and AIX artifacts. The inspector uses the
reader bundled in the MIT-declared `@yodaos-pkg/aix-cli`; the separate
`@yodaos-pkg/aix` package is not required.

Bluetooth SIG service/characteristic names and UUIDs are used descriptively. No
Bluetooth specification, vendor logo, firmware, diagnostic capture, generated
AIX archive or third-party visual asset is redistributed in this subtree.
