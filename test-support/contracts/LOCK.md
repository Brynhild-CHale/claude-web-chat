# LOCK · round v1 · 2026-10-28

Locked by swc on 2026-10-28 under README rule 6. The agreed texts are commit `e635897` (notes/2026-10-28-swc-04.md), read by
wc and agreed in notes/2026-10-28-wc-13.md (04, 05, 10) and notes/2026-10-28-wc-14.md (03, 06, 07, 11, 12). The lock commit
adds only the C-07.12a wording mend wc-14 asked for, the headers' `status: locked` with a changelog line each, this file and
the board. Code baseline: `ae/int` aa60492e (unchanged since the last citation re-read).

Validation at the lock (C-12.24): ajv 8.20.0 with ajv-formats 3.0.1, JSON Schema draft 2020-12, `examples ok=116 fail=0; schemas=41`.

Locked: 8 contracts, 41 schemas, 116 examples and `docs/example-keys.json`. The files are read-only on disk.
A change to any of them is a new file `contracts/NN-name.amendment-N.md` with its own status lifecycle, never an edit
(README rule 6). Catalogue files `schemas/10-mcp-catalogue-<version>.json` are added, not amended (10 C-10.1, 12 C-12.6a).

Contract-set hash (sha256 over the newline-joined `<sha256>  <path>` lines below, in this order): `4f7fc4db1d3cd5906f8b6dcc1ae02127e36e3c7fb12b252e8e83e0491d8751b2`

| File | sha256 |
|---|---|
| `contracts/03-principal.md` | 802f2ba5879f3d22ea3127771417c01ed8befcb35f23d9e3f2b28386a211aa97 |
| `schemas/03-activity-entry.json` | 1a039773473b9372ddff984e4c08da3f8fdf2314dbf291eae7507d85eb7fbf88 |
| `schemas/03-actor-header.json` | 870b1d6a16059fbd8ba875c2c72877bb002930363127c7efdd6109a87a218375 |
| `schemas/03-credential.json` | e08a3cdb9f72798f780c9c5befffcc658761981e952f1c42365d5f1da44e1097 |
| `schemas/03-principal.json` | 0d6e09d206d02d16350a74c2e632d54d5122ce866f69a516278ebbb11e094f12 |
| `examples/03-activity-entry-message.json` | 1eee73cc090f1182073b16d51993bf38c104f5e61b7e6d62c5e2fa9376cf832f |
| `examples/03-activity-entry-revoke.json` | 2a48a511b3d4cbdd75201ab1673d67c97ef97c39ee4a7bb93374d1bb3358d5b3 |
| `examples/03-activity-entry.json` | 9f09c622c33517724e53356ff404db9a58fd5ee1f189cea53167fe9cdc890a3e |
| `examples/03-actor-header-agent.json` | 5c3fbd6a7a15ec85b713f41afe8f1ef6dba8125930b9817d4180611dcc93337f |
| `examples/03-actor-header-named.json` | d806e22a967912c18a687a6332fced69c1a0912eb00ce66dca0e546d413f0979 |
| `examples/03-actor-header.json` | d5761609e376b2a3b7980772ade124830ff92271f87211e97921c67b356c59ff |
| `examples/03-credential-device.json` | b1b78f40b64b4eb0bcc8d95f1bf52696b781df69907f93fe147723e23e263375 |
| `examples/03-credential-machine.json` | c0aaa0d8079a87ad0486f488897a745e08e4ddfd7c33ceeaac900da6fea203d1 |
| `examples/03-credential-surface-session.json` | a5de0dc5aeb4bddef8aa8cbd74bff10f7bc900771b22d5bbcbca6b10c6065850 |
| `examples/03-credential-user-session.json` | e262402b55e1baea6cae502f9a6d49cee8038aecb1dc7afbc4ee87233ef584a2 |
| `examples/03-credential.json` | d1bf66ed23be7b2cfadbfc81c1304aa1ce5580977f9993fa9bc5101034aa9fcd |
| `examples/03-principal-home.json` | 78d744da52c351762682b536bf5721d180c68518bc9949658407e7b994cac79c |
| `examples/03-principal-service.json` | bef1aa6c90c5d75f5506ee5e351011f2590126ca51098b57bce0c0afae607b2d |
| `examples/03-principal.json` | cef083fb9c0204c6d234ab30aeca09265a389c0cb5bebc494ca3ef434e2fe373 |
| `contracts/04-authority.md` | 731edd1ed097c4e9fb4228b9e090292d340cf42b2fbc9bd571f5dba7d4eb57ed |
| `schemas/04-deny-record.json` | 86cf3fc138c2a36648193bd867dacd8d21737f7e4009ddae5792afeec9813035 |
| `schemas/04-level-header.json` | 570445a4e165c11ffaf2a7c9168a6bde9bc169cc9e6ecfe85e2f9de05c55313b |
| `schemas/04-policy-decision.json` | 510eb6545a560bcd2ebdd5adfc307052d1bdffdcb7489ef2e449479cd0d86a54 |
| `schemas/04-refusal-body.json` | 80bfca17bff06893b3529be54821722d1c77e77bedcf85b69593948285ebbd2a |
| `schemas/04-route-table.json` | 94268ac7bacbd18d32637268024d20c4ba21b7f84eb7a7d4954e4fd047a41eae |
| `examples/04-deny-record-log.json` | 3e88c9743f5ac2d89f101ac8ada7404c584e427783df27a1f83c4f93b16bfbdd |
| `examples/04-deny-record.json` | d80b2493ba210ebd1a4a9ec46142f8d1a14c6899969a1d432fde89c20e7b8f3d |
| `examples/04-level-header-basic.json` | 48248ee93bd3b52c450df84fd667694f2f40cbc1594396a311792b9adb71388a |
| `examples/04-level-header-read.json` | 0f03f42f431afc4ac73f6f86973a28d29ad9c588486a1443e5d19f27531d2a1c |
| `examples/04-level-header.json` | 97f15f2c8f97c921d8a5c8b6bf928a1c99cadc558488aec2070c3f0c5c39b841 |
| `examples/04-policy-decision-grantee.json` | e8df8b19e04e0038159544f7013287e50671914289e5dc741c4a678018005d46 |
| `examples/04-policy-decision-home.json` | d18fc02022ecf7ecc3149349e394340f5ff6381043852f181fbe9219f1a860d4 |
| `examples/04-policy-decision-status.json` | 1e3894148a84086ce18b257261eaa4d218bc5bfa0ff6f11871adddfb4887fa4f |
| `examples/04-policy-decision.json` | f39d7eb14b29292048f7afff9aa897ba8d27e65372ad1924e4bd0ca666ebf03d |
| `examples/04-refusal-body-steer.json` | 80f71830b93d146747e03e52821a98e4b897ffbb3b364c7e178cfe62165d6d22 |
| `examples/04-refusal-body.json` | 2ddc33fe78874f4fa55b1f8961adfba59e4730de236cc151cc19be15bb79eb02 |
| `examples/04-route-table.json` | 432c09aa0d7917c76af3dfdd423436475904c682326ada14f889e512eba327b1 |
| `contracts/05-hub-connector-protocol.md` | 36267f63c4d7fe11965e7e19f7fc21d7c5f385c466a11d7e9462cdb306488274 |
| `schemas/05-auth.json` | 147b8de9b9ad545f545ae4e6c2fe47eb963210accbc8e871e454ff5415e08198 |
| `schemas/05-chat-control.json` | 8f406477cd413bad37d7876b7365d221e8c326aadfc50477609d093176ac241c |
| `schemas/05-envelope.json` | 5ec14bb0daa1fcd6cab8dd77c7c34320b899ac646d5ef5e9a5328d6f895d3123 |
| `schemas/05-error.json` | 5835ca66da17b45893f88d379533430a09a8a4b7b3b79c968a451207fcb70322 |
| `schemas/05-event.json` | 2a0a53cc8ddbe0f74864bc3e3a521b66d551dace3d8d494399cf9d23a68af0aa |
| `schemas/05-heartbeat.json` | d951ffb5cfa95bc1bcc0686d20f4c3e80a0ba3e4026d791f0dd87816ee911752 |
| `schemas/05-hello.json` | aa13a46a25e80a05c371120b6cc690f6c5e8cb58e23c13bd84c5a2e111fb2231 |
| `schemas/05-machine-facts.json` | ec09cc1a15883684dc8b06af265549bb5a5071edb0ebfeaebac75541c367e157 |
| `schemas/05-pairing.json` | 0a0a6de6c7a663c49ba821152425d48bb7fb57c25c3239714a3389a7674df0cc |
| `schemas/05-queue-deliver.json` | cc5caa1f4e499978c8219e28e8bad9050f36612363aa7810a6983413d3a07c46 |
| `schemas/05-relay-http.json` | c26e993bdf34ea839370c4accff354b98c09bb569e89706c58744df67e9208eb |
| `schemas/05-relay-ws.json` | aa9f389a2e51d87916d98a05d28031b49b0e1afd3a191b769aa06aeb0bb6dd6f |
| `examples/05-auth.held.json` | 5194b948f13e3aad6e0a345f4640f29477d938e7c347297e374eab69c596aa25 |
| `examples/05-auth.json` | c4a761039535289bb44143dca127dd2e0f2030d8e90f0bc472ba4a3de9ca2864 |
| `examples/05-auth.ok.json` | 0b3a3ca83bac5c71b5f1e1fcce9e41758f2bd04e5cd0d56daa5830b4c9bc0984 |
| `examples/05-auth.response.json` | 1bd193ea9aa21a5ff0d6fc3704ecbf8496377fc05fe5e08ce36d942e32da6bf1 |
| `examples/05-auth.rotate.json` | 2ce38cea248520efeb84cbe20037ff8bb8cb03f24951552ec4ae0b538e9d2c29 |
| `examples/05-chat-control.json` | de04ae4e832d070709fe71735d494ae0170d22b21b22b55226c0cac600033dfa |
| `examples/05-chat-control.status.json` | 4f6de70785e1e2493207dae7f33e85eed30646357ddcaa391fa6223bb0e95610 |
| `examples/05-chat-control.versions.json` | 4aa6596163ec05d9dde05d5ac89b61ab9eac0c931f82141279f184abceaa35df |
| `examples/05-envelope.json` | 5f9d195ad20a72c135eb4dccb27bdf836273f4419449985cb66e5c3d69509c50 |
| `examples/05-error.json` | 0747edd4c0bc63e9dabe0e975420c8797118e830ac567f6b4857268e03642f6a |
| `examples/05-event.ack.json` | 4b31a59599abce84e362593076df38c13a5fbb4816740828f13fee5c52b1fd70 |
| `examples/05-event.ask-opened.json` | 9993e4878baf16c6b744096ca0ca39131c8539c952d4f175aaeba642bb75c201 |
| `examples/05-event.authority-log.json` | d4915f7675f1a9559aab002f2b452fd4c75f4f19dcc8ecaee0e1feff3f598066 |
| `examples/05-event.conversations.json` | 141f4512ebd388b8469f4f8dc0021ea2fd7d438cc3c88d56e5acb0b477c93c74 |
| `examples/05-event.json` | 4e29b27b8f73f32961aa30edbafafb6c1ef043b0b2e62e8b4cfefefc6f2e5969 |
| `examples/05-event.resync.json` | 61823a07b030cd4066e516c412e6b5d862eb7919a2144bf63b62fab2fe3c4944 |
| `examples/05-event.signals-ack.json` | 2bc880876431a7fa25d2888e810c7bc11779cbf5a53a76da2613eee78d301abd |
| `examples/05-event.turn-begun.json` | 5e18ea3b1ab4a7e0713923cecfd7ae69e7ddced9f5e1a931b2761ed86ad30cbb |
| `examples/05-event.turn-ended-superseded.json` | 0fc839ea56f948c5c58645713d9880a6dbcbf58b13ecf2d12d3cfb9e5eb4c08a |
| `examples/05-event.turn-ended.json` | f777378259e7661857b033165d2022d95f0817330d13ff484422a9a439d3217c |
| `examples/05-heartbeat.json` | 1a02947ab459903be1c70178bad5397dfdf3c5589f095688a6b57c542fbd7fd2 |
| `examples/05-heartbeat.ping.json` | 5611ac77f91cb74252d2f6014ca307021085fa7d570c75b5db1718983a40f0b3 |
| `examples/05-hello.ack.json` | d3288d7393d1989bebd9d5f32a4544b16d55d64f60907b6d90c49793a6163d3d |
| `examples/05-hello.json` | 3c68ebec0c691df58aff19bd14b888c38010bcea08914d5a3772a7bda4944690 |
| `examples/05-hello.refused.json` | 61d1c2f7b2387c92572ba5805c9ce4858b71ca40ecb67cde84e058d83226c2ca |
| `examples/05-machine-facts.json` | a510e7fcab3a1f4a37d9f8f928f4a716cc354ebc3689235887b190091a9b9e7b |
| `examples/05-machine-facts.revoked.json` | 1d87210f6e1c9f4342ff207cc086262d8b4974b3e0f69709ca31e6dfbdc608a0 |
| `examples/05-machine-facts.settings.json` | de4cd80d21955a34b566ff85f80412e8e0f0a5709ce39d90ab858ec6d843bfd2 |
| `examples/05-pairing.bound.json` | d11464b9302bca5eb02850008d6bab74bd1faaf5e555a435adce51e549b72be3 |
| `examples/05-pairing.clock-skew.json` | f9b0cd5a991c43cf6e047b12731a68c1a2698609ea6a7381612e3c47c59c6cc4 |
| `examples/05-pairing.json` | 41f690d24998bbad67d8352a61c689f75295fa1605b4611428d51c22a0105133 |
| `examples/05-pairing.poll.json` | 77186a170bb2be4a2b5cc2c9316a68cee6a68abb2b817390b8cf342b008f6f99 |
| `examples/05-pairing.rate-limited.json` | 1e583f40e174dce1cfe193625d37feb52c8bb73a72014d0e789ae00468b94a81 |
| `examples/05-pairing.start-response.json` | 6f060453c0df3782688bddcebe04a1b45244ea0110551f5f84c5e5b4d516f548 |
| `examples/05-queue-deliver.ack.json` | e1a0eed53901b16e536da6e486274b96611b4ecb1f7f414351865029fa0fd6d6 |
| `examples/05-queue-deliver.json` | d1792e4fa2c9ab641128d4e752f446f5e4f26fd8ef6d26406edff0ce1ec307a2 |
| `examples/05-relay-http.abort.json` | 96135c0489e5c27ddf86bb172ad00caa2883795d9b6c2a6ad1d4c52be9318008 |
| `examples/05-relay-http.decision.json` | 070f466475437dc226b84822c42579403ad330e89171c0921cdf3ee0e1da95ec |
| `examples/05-relay-http.json` | 57a978df0b471907565803f4b187d176cfdde8bd9ee717c1d64244fbe9e45cf6 |
| `examples/05-relay-http.post.json` | 8296313f3e18869648e080a4b54d06ca338d8e7d1ed3a35a3f087fc7af468b52 |
| `examples/05-relay-http.refused.json` | 9f863f5113442d035dc314daecdc9eaf22353cd06c13c385ef3260fbea2b1a06 |
| `examples/05-relay-http.response.json` | 4c82e683309967653f4a65f957ba91addb9331a9920fa6cfc72e8b36d9c26e47 |
| `examples/05-relay-http.window.json` | 1f173b50aaaecfcb01f545d28fab8047a2704c521cba7a6d983df32f37577e68 |
| `examples/05-relay-ws.close.json` | 35bae0569bdce0062ea599b309d005950585d3463f83871fdf23986e347cad58 |
| `examples/05-relay-ws.data-more.json` | a2f21e9a06fb1f61c894161c0afc91ef1beda164a0f73b636d6e23d0bbd88591 |
| `examples/05-relay-ws.data.json` | 8f9c21795d0437c698ed1679c27cdd838e7b8dafbc6118a2a0468c56780609e2 |
| `examples/05-relay-ws.json` | 8746312853178db37e2bbd28707c8d03816d6d6be5bcec1ce648bfc867153c12 |
| `examples/05-relay-ws.opened.json` | 619e7c2dfde702f8497ce1c2a564b488072d5cf11c3e8dc814c24bb4b69f0dfa |
| `examples/05-relay-ws.refused.json` | 8f6d2c34d9ead577181db8438c33e9d676c6dd17c7e94164762f307306e87e5c |
| `contracts/06-connector-and-embedded-mode.md` | 6d01069627bae6b7a2e0584eeb44dbe1dee66999300b8c9a924bdf717f35e928 |
| `schemas/06-chat-assignment.json` | 5e306b7638c66e461b8bbe927ff5e40ce278dddcb995737485bb4176ad6a3295 |
| `schemas/06-chat-status.json` | fa8eec5f9b26c81e564be87fa0592a8427e8cbe6070e4ae5fd7c11602646ba92 |
| `schemas/06-connector-state.json` | f86c8481d690bdce2102f341634bb046e7ea46b95ad9c017498cf819fc464cb1 |
| `schemas/06-embed-message.json` | e1fcc10df67d71930e614795df371cc281558f421c9223a429c485e8c2eddae3 |
| `schemas/06-health-embedded.json` | b957f99975d376785a5bda5255eb64deda48ae47b72ac44049aa0046dd88762d |
| `schemas/06-relay-headers.json` | e1deffba4a69d59d31bf6d22b29f3855d257e2bb976f724b8b0951441bfcd42a |
| `examples/06-chat-assignment-repo.json` | acf51782541e4a47963d5e53965da27b760fffba299914b039ec8af177383592 |
| `examples/06-chat-assignment.json` | e25e44eeca882e67ea52f6b123196c0aaa354083b6f813246a61968db9eb59a0 |
| `examples/06-chat-status.json` | 92206eabb0d2288147186771b6ce9f8b2e7a75ed7559658774afbddea2e27795 |
| `examples/06-connector-state.json` | 3857ac5cd038e2776a2936a6f27d2aefc13825690b10ef49fbbf7d131886bc40 |
| `examples/06-embed-message-command.json` | df9f04cdb7df911428bf9b23ebc32c6afea5f63b127b1a4533d57e2bc89e984e |
| `examples/06-embed-message-ready.json` | 736d4d41b6dfe8d388550e4843d0f2b2d99eed529ff03d9db8e79f30f24627bd |
| `examples/06-embed-message-status.json` | 31d104340e60634186d4bf3f9f01100362e14b413c0388290226e25266c1e5f1 |
| `examples/06-health-embedded.json` | 34a2afb5216819cf4e9c567c41f9cdaf47fae7719c6260a742db9cab900d3757 |
| `examples/06-relay-headers.json` | fdcd4555fb21c64147bb12f6004af775ab29ad1bc837bad8d0bf0e0c074449c2 |
| `contracts/07-ordering-and-catch-up.md` | 26aa07982d19a1fa657a6a74a6beda901b6bfbf98c11afc79f97f0bd99c3f5d3 |
| `schemas/07-ack.json` | 7a69d569ff07bdf0caa9ab4fb88f2588faa17116c1a496ed799ba6972f165a38 |
| `schemas/07-cursor.json` | 5541684c41a6d3e6dfdea764e34124c5b351eaa2c1457e93ea68043711f92966 |
| `schemas/07-heartbeat.json` | bd517bf1c544d0ba90b86f4fa1b953859b9fea6c59576ec959449c72fe020f99 |
| `schemas/07-hub-event.json` | 5e8ddcbbe5821c9428f3bb02dfb1787339503e3a0ebfcb7cf7e21b98a7a69607 |
| `schemas/07-queue-deliver.json` | cf167ceb926bd48fdb210ac906dceb5a1e86cca440571d47b0b20b29cfcafcc0 |
| `schemas/07-source-batch.json` | dee7efca375bc30580692a7b0ee001f04bb071a0b19f19dc10d24ae11cd69c81 |
| `schemas/07-stream-frame.json` | 3aadfadbbe8c2ba2abf7d40a6a6be99c2e08c2643056b52605d061bf9023e37f |
| `examples/07-ack-events.json` | 5d88d466fd94ad2baa285ac21d1a8649b71801364cdce7ec725dcbadc8efb9cf |
| `examples/07-ack-retry.json` | 8155e5422d37fe111e37496d18f4f72b94edc0279b88049a248115be2ffe220b |
| `examples/07-ack.json` | c3d43d69ec2545dc93f854d99f5d85338eaf922cff9a6eef5c099c94174c1331 |
| `examples/07-cursor-hub.json` | 410fc9c2f4190d82f1cb345fda015c5353b9d4a8a8bce6f2789c223e4bb11b44 |
| `examples/07-cursor.json` | adb4e5cc55a2fcbeb58439561fd3c468b965a1acae8eae0e2312d1db30ec8fac |
| `examples/07-heartbeat.json` | d8514f848dc5242fcbbfd5d89686d8a49703febfc09b28c1cec088a7353d231a |
| `examples/07-hub-event-gap.json` | 65fe586e0c499d1278790bf0ee87a3e6370f5dd025bd52879ce6cfdb5095af2d |
| `examples/07-hub-event.json` | 37731245c5677b571e03a884cf7b743b65f4652d9c0e683a6b731592bad52747 |
| `examples/07-queue-deliver.json` | ecc565038b111b7a3eddcb668d2abd5762503b003e09db7bcaf9adfd9c3ca2bb |
| `examples/07-source-batch.json` | 18d136212f1da0d0297614d090171781144640012cc5bb49b2cc6e5e16f080b3 |
| `examples/07-stream-frame-hello.json` | 8a53d17e10c4b97c9e4e8a281b53320f40da941c918424846e1e8d47d61417f1 |
| `examples/07-stream-frame-reset.json` | 19aaae977270756ddfb450ab90e506105db53ae2e1ec7fdf892f938324c32569 |
| `examples/07-stream-frame.json` | 45126435cf319778a67d1ba4c4393c0a9f54328ad700259efa62ca72e227d158 |
| `contracts/10-mcp-tool-surface.md` | 7e1f81d103f46025cc03cf8bdc2696144501ace5e5a74e292b0461d0592e0d59 |
| `schemas/10-home-tools.json` | 4f7c8d8bd60e3e3be4a6da88656a50d565cfb08e9348ac4063fb8d84f543df52 |
| `schemas/10-hub-request.json` | 929ec2cb23b5d8d0d12e2b6d830433fa2e9271066fe6c39faaf5c2376fa27b84 |
| `schemas/10-mcp-tools.json` | fa48cd5a34f4f4454d413e0a12ca507d23c7b435fb9b0e7db0f232d57fc8c848 |
| `examples/10-home-tools.json` | 348d621f67afbc33848ad65951294d75987ec4e216dc41f92314d78aaf00bcd3 |
| `examples/10-hub-request-decide-ask-error.json` | d18917a4671427e188e275ed43bfd8c4d4497d741ef8c3f1698ee2076fd6dea9 |
| `examples/10-hub-request-list-chats-ok.json` | d02cdf1fcc35ac3eda21eeae82e38e49dcbb96a0832aed2cab9a1caa69d34c30 |
| `examples/10-hub-request-read-chat-turns.json` | 3c5fa392c38d2a24eadefa690e2c092c690414b68546ef62c7a65ef577f5e8dc |
| `examples/10-hub-request-read-queue-connector-not-running.json` | ca958d93bcfc3fcff69b22c0ceb32dc0904d16a8c4956037fce4fec269de602e |
| `examples/10-hub-request-send-message-ok.json` | c2e6ab10eb8927de3acc1b317419fd197b71d944b40b8100d51d381ce1ca3df4 |
| `examples/10-hub-request-send-message.json` | 65472f522ecc98eb1df9743b70d80ec6866f3129b34cf36e35cb4797f38d99ae |
| `examples/10-mcp-tools.json` | 3128f5003522d6431dbc698c2b99c116711e4d92b5c8a32e57f36665a3322efe |
| `contracts/11-redaction-boundary.md` | 31c771228917496eaaded199728c74913c4cbfe749b1f4d7b3eaeba82b7f71e7 |
| `schemas/11-activity-summary.json` | 449d345ff7b0293b18682035f761b0b88eeb22937b09f8a0038f8e7376799168 |
| `schemas/11-retention-table.json` | 38cc07b249d2ea0de61c6ac48d94d7c2d8da842c0b365e20fb588a84eb004528 |
| `examples/11-activity-summary-user-text.json` | 65ccd152d6be5f66ac9becb5c9efe68b4cff44fefbe24aed727f9c89789ac406 |
| `examples/11-activity-summary.json` | 70d5ac1fa330963651f7053bc87edd07837d65a559d7fd45ae9ff64d2bd5124b |
| `examples/11-retention-table.json` | ee7e3b085344c9e675ec49b6d332b961f3e137a3df863f9b800018de9a47bb64 |
| `contracts/12-packaging-versions-tests.md` | eb459cd7cc8a187f1afc7488da1b1102250f3cf8da55961063cece8b20605cfd |
| `schemas/12-compat.json` | 8752ca908f8277d1cf53a65e84044116526a88e69d646bb33d385714f9f31af7 |
| `schemas/12-exports.json` | 74f5cf53c157e1605a75a628dc10084a56a357494bce0e706ca81f5d02945808 |
| `examples/12-compat-behind.json` | f049ecb532da61aa26d4da9b78b83d1b8541d04268da033f9dab31ba6618bca6 |
| `examples/12-compat-claude-below.json` | 87b9e00abf5788917a369b8d2badfd0cc3c3eab9eb445801db4fb7a7cb795af0 |
| `examples/12-compat-daemon-versions.json` | c676431023f2a71e4166b2f642e718e14bbc70d61dd1cde2bb42d3b1f87a65d0 |
| `examples/12-compat-dev.json` | 4553c2d9b7b98544f686604a295f8895be380cccbab9e16f1e48f64790b7717b |
| `examples/12-compat-ok.json` | 7fcbc70e6d562141ddad0b48d32ccb12da8f9ed0beedc8c0e6df34bd4ed3ddb1 |
| `examples/12-compat-refused.json` | ad0ee20bcdc500684947e8e278f9793c3fac92d9ac0802e11d2cb027d615f27e |
| `examples/12-compat-versions.json` | 3c20c76b7f7837ef0f077d228dcd6df9ef6a7d3993b5b3f26c86fd98987a0c84 |
| `examples/12-exports.json` | 68a9ece410ca99f3695133d33c984b90dba9aa5cd92a4d29f5fa16bcc0c4f552 |
| `docs/example-keys.json` | 2aae16944ac5f4a93864e06cc95c92655005116aeecb3c27181197b00a79c264 |


# LOCK · round v1.1 · 2026-11-01

Locked by swc on 2026-11-01 under README rule 6a: the eight amendments wc agreed (A-03.1, A-07.1 in notes/2026-11-01-wc-19.md;
A-03.2, A-05.1, A-05.2, A-10.2, A-11.1, A-11.2 in notes/2026-11-01-wc-21.md), each with its folder of full replacement
files, plus the catalogue 1.0.0 pair wc minted (notes/2026-11-01-wc-20.md; added, never amended, 10 C-10.1). The hub and
web-chat load each folder's schemas over the v1 base. A-03.2's files supersede A-03.1's and A-11.2's supersede A-11.1's
(both pairs agreed), so a loader takes the later file where both replace one path. The round v1 lock above is unchanged.
Still open in round v1.1 (not locked): A-06.1, A-10.1, A-05.3, A-03.3 (proposed, owner wc) and contract 08 (v2, proposed).
Code baseline: `ae/int` 503b8f2f (tag `ae-alpha.3`).

Validation at the lock: `node tools/validate.js` `examples ok=127 fail=0; schemas=46`; `node tools/validate-amendments.js` for the locked folders:
`amendment 03-1: examples ok=131 fail=0; schemas=46`
`amendment 03-2: examples ok=139 fail=0; schemas=46`
`amendment 05-1: examples ok=128 fail=0; schemas=46`
`amendment 05-2: examples ok=129 fail=0; schemas=46`
`amendment 07-1: examples ok=128 fail=0; schemas=46`
`amendment 10-2: examples ok=128 fail=0; schemas=46`
`amendment 11-1: examples ok=127 fail=0; schemas=46`
`amendment 11-2: examples ok=127 fail=0; schemas=46`

Amendment-set hash (sha256 over the newline-joined `<sha256>  <path>` lines below, in this order): `e59a978a8ba08c878fb538090298607bc0c75bb6fa1aaf0ffb4933f2a5dafa9d`

| File | sha256 |
|---|---|
| `contracts/03-principal.amendment-1.md` | a161ed693d1b1a56a328ab8bed6d4ad9ab7534ec3d9dd687da009ec7744b661a |
| `amendments/03-1/schemas/03-activity-entry.json` | 7b5c28b35cb87d1136c7652105fa9c398a9223639550612b9150f185e356410f |
| `amendments/03-1/schemas/03-credential.json` | 53194cc4db689f2ca8391775a41e5f8b7b29a59ce49cea290bdfe668a19434e4 |
| `amendments/03-1/examples/03-activity-entry-user-allow.json` | c0b93a8595c309c77afc35900a5a17e048ed539d937392ec9132c6e03bd568e8 |
| `amendments/03-1/examples/03-activity-entry-user-remove.json` | 75fd0127d6ea5205f005204e4f923c62d578f3219a55ffe06db21c09a508dcbf |
| `amendments/03-1/examples/03-activity-entry-user-role.json` | 7a21ab34a82b698121353d434649871a01bfee203c12193a0861c98d2d05db8c |
| `amendments/03-1/examples/03-credential-user-session-github.json` | 70ee24cd98b75eb7a5083c9853533dfa4007a5483d53393cd55406d20290b8b8 |
| `contracts/03-principal.amendment-2.md` | 70e9023f4e8da7af64fc6b65428420ac838d8c04545e51862f04b29686bb6ebb |
| `amendments/03-2/schemas/03-activity-entry.json` | eabe0b5d9f1ec0bf3887fe98fe0f344d5cc9b39fc557fce25a9ae2c8498e3fcd |
| `amendments/03-2/schemas/03-credential.json` | eb0e671f472072bdb3c30ae5d0d11af95f9db1b04001026942fd5846c25b0780 |
| `amendments/03-2/examples/03-activity-entry-passkey-add-refused.json` | 5a2cac0adfe4cb7e02c1de609c7aa4f1ca4d3b10b0e3796dc81452fc6b7ad91a |
| `amendments/03-2/examples/03-activity-entry-passkey-add.json` | 42ccdd0ed04c763d256fc2b0286dc73e3f5a537e287fd6e91e899a04a264295a |
| `amendments/03-2/examples/03-activity-entry-passkey-counter.json` | 6993e1c8ff5227b0a9d2f4390d77209fdd68d9a86cd3472a7dd408268bc35915 |
| `amendments/03-2/examples/03-activity-entry-passkey-remove.json` | d69df642be47e1dbcbbb117b2b51764ea4ae14eb871de05a54f75b01207b601d |
| `amendments/03-2/examples/03-activity-entry-passkey-session-revoke.json` | 6e6a227ddb5d7c442d9414224d482dce9a5b8f25be6d60eeda6f62878d8b82eb |
| `amendments/03-2/examples/03-activity-entry-passkey-sign-in.json` | ca46ebdb68e55656554c4916fe2108f75ef2d7a48257e4016ffad636812dc7c7 |
| `amendments/03-2/examples/03-activity-entry-passkey-unknown.json` | 469f63617278b88c2169c2784351974c8177c3539650432302028e88b94e0c32 |
| `amendments/03-2/examples/03-credential-passkey-revoked.json` | b8d8ca8b048b0f8dd3aca4306897dab67e087704f614f31f70780ec3646b1706 |
| `amendments/03-2/examples/03-credential-passkey-unused.json` | 361c32070fdc33bfb96754282cd7839cc8f374f46ed4debf4120ed4fe72ed58e |
| `amendments/03-2/examples/03-credential-passkey.json` | f625ef9446354a59b36bd14ca596859f981011218acfd1e664815196a5d04a42 |
| `amendments/03-2/examples/03-credential-user-session-passkey-revoked.json` | 5ea9fa9c015f4a285e80dcfd98d97bcba1ca541113c167ad222092a0d236af44 |
| `amendments/03-2/examples/03-credential-user-session-passkey.json` | 4f03ead9037a0df2a6f7dcfadccd91858c12f33833e42b932542fc192d611a20 |
| `contracts/05-hub-connector-protocol.amendment-1.md` | b3e0cbef8ffcf926ca88cb618947cd4d1b573a830b1d9b423edde75c46adc4d9 |
| `amendments/05-1/examples/05-error.too-large.json` | ab04731b11ee88caded4c3f6459cd18f1d9ab1fe486c22f9f9e04898e09482bc |
| `contracts/05-hub-connector-protocol.amendment-2.md` | a4c9fc3f9b9540f922fcd84ab3574492b604301b366801bede64659f4b7aae09 |
| `amendments/05-2/schemas/05-machine-facts.json` | 56d0b9d1f0dccdaf94c412e1df6d26a8361cfa9b744bb0e5a24788c32e5a2f01 |
| `amendments/05-2/examples/05-machine-facts.no-tailnet.json` | c870353831e9f283e1556f62fd825a680989b20e633657e42bea1d22c206d111 |
| `amendments/05-2/examples/05-machine-facts.tailnet.json` | f09add055ca3486308d014f9fa81f2d3d96d027015340aa912ac239e953d8f2b |
| `contracts/07-ordering-and-catch-up.amendment-1.md` | b7b4475cb66af8758923b7b920f35fa6ccb2118ea5797d22c65376ad7e28f9d0 |
| `amendments/07-1/schemas/07-hub-event.json` | 0647e677b8a0c866f41b7e9b39d716d59534bbcdb3a92a608a6193723afc471f |
| `amendments/07-1/examples/07-hub-event-activity.json` | 977959d9757a1d4d9b727641069ced9876711dc48cb4b3eca08c317607fb6a65 |
| `contracts/10-mcp-tool-surface.amendment-2.md` | 0454a6a7d504ec9fc877d5c8951cf007dcb6119927bddc3e93ab6ce1d56bf05a |
| `amendments/10-2/examples/10-hub-request-idempotent-conflict.json` | 1ae5577877e3af97ff66042f1a63a27a2df36b8b674cf1c90d177f3d21dc2b3e |
| `contracts/11-redaction-boundary.amendment-1.md` | 6af97055ba20c05df13df76f2795a2f986df80c82491739112b78d48f5357112 |
| `amendments/11-1/schemas/11-retention-table.json` | 4a4cfb0c3d379802a14f4125e2e948b82007c11a60b50351422b004dd214276f |
| `amendments/11-1/examples/11-retention-table.json` | 3c3c5054fe528c8ec26cc62c79fef62920cf442584ac92c795880f1d8561c0a5 |
| `contracts/11-redaction-boundary.amendment-2.md` | c809372d9fe46b02837e0736f64da0bccf96c672069f3527a838d8671eceebed |
| `amendments/11-2/schemas/11-retention-table.json` | 4a4cfb0c3d379802a14f4125e2e948b82007c11a60b50351422b004dd214276f |
| `amendments/11-2/examples/11-retention-table.json` | cb69e8809cbf59967af050bec9ae7a57fa3fe5e1b9853a087797bbc135c4152e |
| `schemas/10-mcp-catalogue-1.0.0.json` | a97c21823662d5768e0182b600339f346a0ef0e81778fedc532b3bd36dd5c057 |
| `examples/10-mcp-catalogue-1.0.0.json` | 785e50703a9a35df9e37942e13a3e7bbe8f543b075c224e9a304c9395f4a3b97 |

# LOCK · round v1.2 · 2026-11-03

Locked by swc on 2026-11-03 under README rule 6a: the three amendments wc agreed in notes/2026-11-03-wc-25.md (A-06.2 and
A-04.1 together, the hub's port in a chat's origins and in the decision's origins and `X-WC-Answer-Origin`; A-10.1,
GetChatAttach), each with its folder of full replacement files. The hub and web-chat load each folder's schemas over the
v1 base and the round v1.1 folders (A-10.1's `03-activity-entry.json` replaces A-03.2's where both replace that path,
being the later agreed file; A-06.2's three 06 schemas and A-04.1's two 04 schemas replace base files no earlier round
replaced). The round v1 and v1.1 locks above are unchanged. Still open in round v1.1 (not locked): A-06.1, A-05.3,
A-03.3, A-03.4 (proposed, owner wc after swc applied wc-25's one change each on 2026-11-03) and contract 08 (v2,
proposed, owner wc after wc-26's one change). Code baseline: `ae/int` 503b8f2f (tag `ae-alpha.3`).

Validation at the lock: `node tools/validate.js` `examples ok=127 fail=0; schemas=46`; `node tools/validate-amendments.js` for the locked folders:
`amendment 04-1: examples ok=129 fail=0; schemas=46`
`amendment 06-2: examples ok=130 fail=0; schemas=46`
`amendment 10-1: examples ok=137 fail=0; schemas=46`

Amendment-set hash (sha256 over the newline-joined `<sha256>  <path>` lines below, in this order): `cc658cce98c622115a7615010a2b9376529c3d03506914789026e5b4669da8db`

| File | sha256 |
|---|---|
| `contracts/06-connector-and-embedded-mode.amendment-2.md` | 4362aa65501cb2eb3e5e0d7dbfc10bc143c2fa19bdc721c50ae969fb87f1dff2 |
| `amendments/06-2/schemas/06-chat-assignment.json` | d7c753a82a4ceabafb342879403b2179bf6cbc9e4d58abbcf2adbcb971dae62a |
| `amendments/06-2/schemas/06-health-embedded.json` | ae213542aab36411f1da84f077e2cae62a54d3798bcc68b9909762b28f98f23f |
| `amendments/06-2/schemas/06-relay-headers.json` | cda07813e14b99133399bb9f65bcb0073428ae3b66e5d3417b2748063aed77c4 |
| `amendments/06-2/examples/06-chat-assignment-local-port.json` | 8da3e2a2d4816fd5aa4a9fe9ab6c37fbf758ebd9aae448b3a41b834f0a7fc7aa |
| `amendments/06-2/examples/06-health-embedded-local-port.json` | 497504b2b1e07fac67e125e9c624e663270f8a2e5ee4105ca0e80ff31766cab3 |
| `amendments/06-2/examples/06-relay-headers-local-port.json` | b403e037f2cfedf2ab5fcc5a0315081a649e71aa339ffbee193c9d4d83ef7c87 |
| `contracts/04-authority.amendment-1.md` | 8d7228799494ec84b04b5ca93fb30e54cdd02c8ed97fc6565376e72e784af551 |
| `amendments/04-1/schemas/04-level-header.json` | a266312c297ae28b839a703e68b3c3c9ccc093d878b5ac5dc54af759ee6a0f00 |
| `amendments/04-1/schemas/04-policy-decision.json` | d07fc8fd66e0b426b705f04e5a88087c43df49762b887ca314ce0efaaeaf11fd |
| `amendments/04-1/examples/04-level-header-local-port.json` | 77a2b9b016e8592817ec9d4f15cca6bd1992ba9dfb0655518c08cbc6bc3f292e |
| `amendments/04-1/examples/04-policy-decision-local-port.json` | a2fe74ff6104abce53064c61d6dfa1b850b143020e85e64a3566c67f23d3aece |
| `contracts/10-mcp-tool-surface.amendment-1.md` | 799e1b0911e38ec73a118f9e9ce72f1ac83f7c22162b13099f010a11b5ca4894 |
| `amendments/10-1/schemas/03-activity-entry.json` | 22732d1d208c692ece46c2f8e5111d50aafdae48abea1aca4ee85c596411d90f |
| `amendments/10-1/schemas/10-hub-request.json` | 11947bf76c4e23f4d6baf9bedb2a8164541b4fa6b0549a5c4b931d76abacfc72 |
| `amendments/10-1/examples/03-activity-entry-attach-read-connector.json` | db796bfb28bce0b1d54dc4c6da8d6874009cafe05a37c1fbb47dd68be32811d9 |
| `amendments/10-1/examples/03-activity-entry-attach-read.json` | b4f85574e00ab110e9212c1f2e4affdd40352bcec6162486b4bfba8dca44bf67 |
| `amendments/10-1/examples/10-hub-request-get-chat-attach-forbidden.json` | 7f2fa72d0e004bb64a6450c9910e79cd903e63d9aea5ad86928065e5c95b280d |
| `amendments/10-1/examples/10-hub-request-get-chat-attach-manual.json` | d3cd9bb3e32f80bdeb6f4a47b7639fa7516449e829bc87fb5ee76bac6d3f5e5f |
| `amendments/10-1/examples/10-hub-request-get-chat-attach-needs-trust.json` | 6ff48534a2e52e896f29fb22583b31c0e16735bd2208c9aa9bd6935ced880e0d |
| `amendments/10-1/examples/10-hub-request-get-chat-attach-no-agent.json` | a6d97c5357d0d2ad0d948031e2f651e04b06c0f7a59caf26b977eebc315b9e10 |
| `amendments/10-1/examples/10-hub-request-get-chat-attach-no-tailnet.json` | 949c9dc83a5125d20a4e8960db3d552fd32a5a0c52f14b6b8dd6bfd62c9779a4 |
| `amendments/10-1/examples/10-hub-request-get-chat-attach-ok.json` | 8ca254a6e27374dbf3020cd79b9695b29b5b89759b6b58765c225f26e4890460 |
| `amendments/10-1/examples/10-hub-request-get-chat-attach-start-first.json` | 08b08081bef78483c99c20d535532bfcd6a60e04775924f6d6960f42a482fb75 |
| `amendments/10-1/examples/10-hub-request-get-chat-attach.json` | ab6c5d8cfda1ff96077e120eaf05ce62a2f32c60f681ff99491fdd5603e1679a |

# LOCK · round v1.3 · 2026-11-04

Locked by swc on 2026-11-04 under README rule 6a: the four amendments wc agreed in notes/2026-11-04-wc-27.md after re-reading
swc's one-change applications by diff (A-03.3, the connector-read row, C-03.6d and the section 2 clause for A-05.3's two
bodies; A-05.3, the connector's one local socket and the `hub.request` / `hub.response` pair; A-06.1, terminal attach,
agreed with A-05.3; A-03.4, C-03.25 and C-03.26 on a forwarded write's entry, text only), each with its folder of full
replacement files where it has one (A-03.4 has none). The hub and web-chat load each folder's schemas over the v1 base and
the round v1.1 and v1.2 folders (A-05.3's `05-hub-request.json` is a new schema; A-06.1's `06-chat-status.json` replaces a
base file no earlier round replaced). The round v1, v1.1 and v1.2 locks above are unchanged. Still open: A-10.3 (proposed,
owner wc after swc applied wc-27's one line on 2026-11-04, notes/2026-11-04-swc-18.md) and contract 08 (v2, agreed in wc-27
under README rule 5's R19 exception; it locks at v2, not here). Code baseline: `ae/int` 627c5f53 (web-chat's local tag
`ae-alpha.4`; the public tag is still `ae-alpha.3` at 503b8f2f).

Validation at the lock: `node tools/validate.js` `examples ok=127 fail=0; schemas=46`; `node tools/validate-amendments.js` for the locked folders:
`amendment 03-3: examples ok=128 fail=0; schemas=46`
`amendment 05-3: examples ok=129 fail=0; schemas=47`
`amendment 06-1: examples ok=129 fail=0; schemas=46`

Amendment-set hash (sha256 over the newline-joined `<sha256>  <path>` lines below, in this order): `c65e31f2ae99b29fb6c624b44a39ce836c9ca90888ecc7e678ea2a2f32087d2c`

| File | sha256 |
|---|---|
| `contracts/03-principal.amendment-3.md` | 6421c6b3472c61910584f839741ac44a5a1a4b2a650c4e1f281b1323ccf1e55e |
| `amendments/03-3/examples/03-activity-entry-sign-in-rebound.json` | 85a01b0e5acc08c74518ab8482fc4de260239636273d8dd02629d4884f07d4ad |
| `contracts/05-hub-connector-protocol.amendment-3.md` | a59ffe1f270ab698d588faacf70a05ffea278482853b2977c5b8d72410aaa6a6 |
| `amendments/05-3/schemas/05-hub-request.json` | d11f534cf3fec7956e3c5b2b7f5be7e04bee0d3b36b2d8c40fbc3bae200bfb8a |
| `amendments/05-3/examples/05-hub-request.json` | 1022f024ab83157725e541efbd8ed9980cf75dc452ce1a3c8a226cd5b8870743 |
| `amendments/05-3/examples/05-hub-request.response.json` | e09bbabbe20e1c5d73c981e92286d32229b53b3b466b3c62c26630935dbc84fc |
| `contracts/06-connector-and-embedded-mode.amendment-1.md` | a561cc1f62b19aadadc6742c894f42990ac3a64d0b56cee35d418ba098baabc6 |
| `amendments/06-1/schemas/06-chat-status.json` | 51c4cd60e8b977523c9d2c1c36eeebc2c1762e4268e04f21ba5e293ef38012a7 |
| `amendments/06-1/examples/06-chat-status-connector-tmux.json` | 4e0edcd2878426021cf3b658bf58834ed9a04248fe7e692a9bb60f9fab5242e1 |
| `amendments/06-1/examples/06-chat-status-manual.json` | 476ad47b539a7a298894039004e8b49012ca0f51ea0d1079f17bfe931472fb63 |
| `contracts/03-principal.amendment-4.md` | aff05e3abd95d0f36a005d0976ef66209cb8edf464d96c4af7b68188916da95f |

# LOCK · round v1.4 · 2026-11-05

Locked by swc on 2026-11-05 under README rule 6a: the two amendments wc agreed in notes/2026-11-05-wc-29.md (A-03.5,
`chat.update`, agreed there with five rule-2 minors; A-10.3, StartChat and StopChat with the optional `stop_mode`, agreed
under wc-29 section 4 once swc applied its CR1 as wc's text (b), verbatim: a chat holding a machine but no assignment
revision has nothing to stop and a StopChat on it answers `conflict` with a hint naming StartChat, notes/2026-11-05-swc-20.md),
each with its folder of full replacement files. The hub and web-chat load each folder's schemas over the v1 base and the
round v1.1, v1.2 and v1.3 folders (A-10.3's `10-hub-request.json` and A-03.5's `03-activity-entry.json` are both written on
A-10.1's files). The round v1, v1.1, v1.2 and v1.3 locks above are unchanged. Still open: contract 08 (v2, agreed in wc-27
under README rule 5's R19 exception; it locks at v2). A-03.6 is reserved for the sweep of kind-less mutations at the hub's I3
planning day with wc-29's names. Code baseline: `ae/int` 07527410 (the installed 0.9.0-alpha.4; the public tag is still
`ae-alpha.3` at 503b8f2f); the hub's `swc/int` 490d3ab.

Validation at the lock: `node tools/validate.js` `examples ok=127 fail=0; schemas=46`; `node tools/validate-amendments.js` for the locked folders:
`amendment 10-3: examples ok=135 fail=0; schemas=46`
`amendment 03-5: examples ok=129 fail=0; schemas=46`

Amendment-set hash (sha256 over the newline-joined `<sha256>  <path>` lines below, in this order): `2e6974fc4e07e39b5e2a5e30a63e83a207622fb5c97bbc4ff5647134befadf2a`

| File | sha256 |
|---|---|
| `contracts/10-mcp-tool-surface.amendment-3.md` | 9ca6654ffd4e73854a1e878bbfd290772fc162108d9dd168b13b76705feef707 |
| `amendments/10-3/schemas/10-hub-request.json` | 01dd9234e8a61184d41773bc30cd3130bf7c42b4f35aaa593c542b16b5e4275a |
| `amendments/10-3/examples/03-activity-entry-chat-stop.json` | b048fa4aa7d2ca986d1b058f5fb1328bf0c11ca57d244da7ad32b94fef6e0102 |
| `amendments/10-3/examples/10-hub-request-start-chat-no-machine.json` | 171c6a3e46f9b34bac4bc26b51b71ca7ea0e800def221840dba5d1985d898bb0 |
| `amendments/10-3/examples/10-hub-request-start-chat-ok.json` | 19c324878a5dc2b158dc7252de7db5006f393dca600ecd268b861c799a71347a |
| `amendments/10-3/examples/10-hub-request-start-chat-refused.json` | 6bda5a3c61357b2b342836257b48c8c38b98067d484c35a4274cb8beb3eec8eb |
| `amendments/10-3/examples/10-hub-request-start-chat.json` | bd4099320f4c0ed71eec428d1f30abb368b8fd483ce9063a5c1177511228bb4f |
| `amendments/10-3/examples/10-hub-request-stop-chat-offline.json` | 18f7a66726721a9315a4a3b0c7b7b0e3e247092f68985214ba5f6b685285e210 |
| `amendments/10-3/examples/10-hub-request-stop-chat-ok.json` | c395ae53d6bca3b12205f1a99246ae1eac56eec02386c9837b7a2acf48735b6f |
| `amendments/10-3/examples/10-hub-request-stop-chat.json` | 65584cc2fb7f6a1cbb752b7384d333d747a7caa0b4a535e31b797f16d2dcc084 |
| `contracts/03-principal.amendment-5.md` | 827b59956197e280a86dbf1e3cc4a6e3e358b59bcaada45e6dae1f40a04dbdd4 |
| `amendments/03-5/schemas/03-activity-entry.json` | 22e536848399825a0d50cb45bcfe3b739863cddaf46d940e1019d1b80097d27b |
| `amendments/03-5/examples/03-activity-entry-chat-update-refused.json` | 880fa54cd47a2ce07e5d9e012538565597b8da4ace014d1ad3fe3282bf48a174 |
| `amendments/03-5/examples/03-activity-entry-chat-update.json` | 61cd888a80c40f1f806b001fdf03032b880cbd4debb833b5359afd73bf3d4f79 |
