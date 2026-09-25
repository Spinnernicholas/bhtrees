# YAML profile fixtures

`profile.json` contains project-authored fixtures for the supported application
profile and explicit rejections. `test/yaml.test.js` also checks limits, writer
round trips, and equivalent tree/value behavior through JSON and YAML.

`upstream/*.yaml` are unmodified source fixtures from
[yaml/yaml-test-suite](https://github.com/yaml/yaml-test-suite), pinned at the
commit in `upstream/REVISION`. Their MIT license is in `upstream/LICENSE`.
The test extracts literal `yaml` and `json` fields without using the parser under
test to interpret the fixture wrapper.

| ID | Coverage | Expected result |
| --- | --- | --- |
| 229Q | Sequence of mappings | Matches upstream JSON |
| 236B | Invalid value after mapping | Syntax error |
| 27NA | Directive and inline document start | Rejected by this profile |
| 4CQQ | Multiline plain and quoted scalars | Rejected by this profile |

The latter two are valid YAML outside the supported profile. This small selection
is an initial conformance check, not a claim to pass the full upstream suite.
