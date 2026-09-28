# Brazilian Portuguese (pt-BR) translation glossary

The panel's Brazilian Portuguese locale is written by several people at once. This file is the
shared vocabulary they work from. **Use these renderings.** Consistency across screens matters more
than any single word being the nicest possible choice. An operator who reads *base* on one screen and
*abrigo* on the next has to stop and work out whether they are the same thing, and they are usually
reading mid-crisis.

Target is **Brazilian Portuguese (pt-BR), not European Portuguese.** *Você*, never *tu* or *vós*.
*Arquivo*, not *ficheiro*. *Tela*, not *ecrã*. *Usuário*, not *utilizador*. *Salvar*, not *guardar*.
*Excluir*, not *eliminar*. *Celular*, not *telemóvel*. If a word is spelled differently in Portugal
(*equipa*, *registo*, *secção*, *facto*), use the Brazilian spelling (*equipe*, *registro*, *seção*,
*fato*).

If you need a term that is not here and it will appear in more than one namespace, add it to this
file (in "Terms coined during the pt-BR pass" at the bottom) in the same commit as the strings that
use it.

## Where the in-game words come from

For anything that exists inside Project Zomboid (sandbox options, zombies, loot, safehouses,
factions, access levels, map and world terms, items, vehicles), the tiebreaker is **the game's own
official PT-BR text**, so the panel says what the player already sees in-game. The game ships it at:

```
<PZ install>/media/lua/shared/Translate/EN/*.json     English
<PZ install>/media/lua/shared/Translate/PTBR/*.json   official Brazilian Portuguese (same keys)
```

Find the English wording in `EN/*.json` (mostly `Sandbox.json`, `IG_UI.json`, `UI.json`,
`ContextMenu.json`), then read **the same key** in `PTBR/`. Read-only; never edit the install. A
one-liner that does the lookup:

```
node -e "const P='D:/SteamLibrary/steamapps/common/ProjectZomboid/media/lua/shared/Translate',fs=require('fs'),rx=new RegExp(process.argv[1],'i');for(const f of ['Sandbox','IG_UI','UI','ContextMenu']){const en=JSON.parse(fs.readFileSync(P+'/EN/'+f+'.json','utf8')),pt=JSON.parse(fs.readFileSync(P+'/PTBR/'+f+'.json','utf8'));for(const k in en)if(rx.test(en[k]))console.log(f+':'+k+'\n  EN: '+en[k]+'\n  PT: '+pt[k])}" "safehouse"
```

Two things the game does that we deliberately do **not** copy:

- **Title Case.** The game capitalises every word of a label (*Quantidade de Zumbis*, *Lista de
  Permissões*). Portuguese orthography does not, and the rest of this panel is sentence case. Take
  the game's **words**, not its capitalisation: *quantidade de zumbis*, *lista de permissões*. The
  one exception is `sandboxPz.json` and the sandbox labels mirrored from it (see the section near
  the end), which are the game's text verbatim.
- **Oficina** for Steam Workshop. See the Workshop ruling below.

## Do not translate

Product and protocol names stay as they are:

`Project Zomboid`, `PZ`, `Build 41`, `Build 42`, `B42`, `Steam`, `SteamCMD`, `Workshop`, `Docker`,
`RCON`, `OIDC`, `SSO`, `PanelBridge`, `Discord`, `SFTP`, `Lua`, `INI`, `UID`, `GID`, `URL`, `API`,
`HTTPS`, `CORS`, `JSON`, `systemd`, `OpenRC`, `cron`, `Ko-fi`, `GitHub`, `Tailscale`, `ZeroTier`,
`VPS`, `LAN`, `IP`, `CPU`, `RAM`, `XP`, `GM`.

`shell.json`'s `brand.*` values (`Project Zomboid`, `Zomboid`, `Control Panel`) are the product's
name and stay in English, as in the Spanish locale. Everywhere else, "the panel" in prose is *o
painel*.

Also never translated: file paths, folder names, file names (`PanelBridge.lua`, `mod.info`,
`servertest.ini`, `SandboxVars.lua`), server.ini and SandboxVars keys (`PublicName`, `Mods=`,
`WorkshopItems=`, `Open=false`, `ZombieConfig`), environment variables, error codes (`EACCES`),
RCON and console command names (`servermsg`, `/setaccesslevel`), capability keys
(`backups.manage`), cron expressions, anything inside `{{double braces}}`, `$t(...)` references,
and tag names like `<1>`, `<b>`, `<code>`.

Game-literal tokens, left as the game writes them: Project Zomboid's chat scopes (General, Say,
Local, Shout, Q shouts), the `[ADMIN]` / `[SAY]` / `[FACTION]` / `[SAFEHOUSE]` chat tags, the
`SERVER.INI` and `SANDBOX` section labels, the lowercase access-level values a command takes
(`admin`, `moderator`, `overseer`, `gm`, `observer`, `user`, `none`), and `iso` in "iso regions"
(the engine's own `Iso*` class prefix).

### English loanwords we keep, and their gender

These are what Brazilian Project Zomboid players and server admins actually say. Translating them
would read as a translation of a game the reader already knows. Use the article shown.

| Word | Gender / plural | Note |
| --- | --- | --- |
| mod | o mod, os mods | the game's own PT-BR says *Mods* |
| Workshop | **a** Workshop | always capitalised; *da Workshop*, *na Workshop*. See the ruling below |
| chunk | o chunk, os chunks | the game's own PT-BR says *Chunks* |
| sandbox | o sandbox | the game says *Opções do Sandbox*; we write *opções do sandbox* |
| save (noun) | o save, os saves | the game's own PT-BR noun for a savegame (*excluir esse save*). The verb is *salvar* |
| spawn | o spawn | only inside *ponto de spawn* / *região de spawn*, as the game does. The verb is *gerar* |
| backup | o backup, os backups | *fazer backup* (verb). Not *cópia de segurança* |
| snapshot | o snapshot | |
| log | o log, os logs | not *registro* (see core vocabulary) |
| crash | o crash, os crashes | noun only; see "crash" below for the verb |
| Dashboard | o Dashboard | the page. See the dashboard ruling below |
| chat | o chat | *chat do jogo*, *chat de voz* |
| console | o console | |
| bot | o bot | the Discord bot |
| webhook | o webhook | |
| token | o token | |
| host | o host | the machine; *a máquina host* where clearer |
| build | a build | a game build (*nova build no branch*); "Build 42" as a name stays as is |
| branch | o branch | Steam beta branch |
| online / offline | invariable | *jogadores online*, *servidor offline* (no hyphen, no inflection) |
| tile | o tile, os tiles | a world-map image tile |
| noclip | o noclip | the game says *No Clip* |
| heartbeat | o heartbeat | debug pages only |
| ping | o ping | |
| upload / download (nouns) | o upload, o download | the **verbs** are *enviar* and *baixar* |

## The rulings that bite

These are the decisions most likely to be made differently by different people. Each one was
checked against the game's PT-BR files and against what the other locales did.

1. **Workshop stays *Workshop* (feminine).** The game's PT-BR and Steam's PT-BR client both call it
   *Oficina*. We keep *Workshop* anyway, like es, fr, de and ht: it is what Brazilian PZ admins say
   (*mods da Workshop*), it is what every setup tutorial says, and the operator is matching it
   against Steam URLs and the `WorkshopItems=` line. **Never *Oficina*.** Feminine, because
   Brazilians say *a Workshop* (from *a Oficina*): *item da Workshop*, *coleção da Workshop*,
   *página da Workshop*. **Workshop ID** becomes *ID da Workshop*, and **Mod ID** becomes *ID do mod*
   (plural *IDs de mod*), so the two sit side by side as a pair. The short `WS` badge stays `WS`
   (fr, de and es keep it too).
2. **safehouse → *base*.** The game's PT-BR uses *Base* for every safehouse string (*Lista de Bases*,
   *Reivindicar Base*, *Renascer na Base*). Never *abrigo*, *casa segura* or *refúgio*. When "base"
   is needed in its other English sense (base map, base game, base URL), say *mapa base*, *jogo
   original*, *URL base*: none of those will be mistaken for a safehouse.
3. **whitelist → *lista de permissões*.** The game's PT-BR word, in every whitelist string. Never
   *lista branca*, never bare *whitelist*. The CORS "allowlist" in settings is a different thing:
   call it *origens permitidas*, so it never reads as the player whitelist.
4. **role → *cargo*, capability → *permissão*.** Both are the game's own B42 PT-BR words (*Lista de
   Cargos*, *Permissões:*), and *cargo* is also what Discord's PT-BR calls a role, which matters
   because discord.json talks about Discord roles and panel roles side by side. The panel's English
   already uses "permission" and "capability" for the same thing (`requires the backups.manage
   permission`), so both become *permissão*; nothing is lost. Roles & Permissions is *Cargos e
   permissões*.
5. **dashboard → *Dashboard*; the panel → *o painel*.** *Painel* is the natural word for both, and
   that collision is exactly what es avoided with *tablero*. *Dashboard* is common in Brazilian
   software and it is what de chose too. Never *painel* for the Dashboard page, never *Dashboard*
   for the app. The in-game Admin Panel is the game's *Painel Administrativo*.
6. **refresh / reload → *recarregar*; update → *atualizar*.** The game uses *Atualizar* for
   Refresh, but on this panel "Update server" (runs SteamCMD) and "Refresh status" can sit on the
   same screen. Two buttons both reading *Atualizar*, one of which downloads a new server build, is
   a safety bug. So *atualizar* / *atualização* means software updates only (game build, mods,
   panel, PanelBridge) and re-reading data is always *recarregar*.
7. **delete → *excluir*; remove → *remover*; wipe → *apagar*; clear → *limpar*; reset →
   *redefinir*.** The destructive ladder has to survive translation.
   - *excluir* deletes one thing that has a name (a backup, a role, a task, a template): the
     game's own word.
   - *remover* takes something out of a list or config without destroying it (remove from
     whitelist, remove a mod from the server).
   - *apagar* is for **wipe**, always with its object: *Apagar dados do servidor*, *Apagar agora*,
     *Dados do servidor apagados*. It is the permanent, no-undo operation. Never *limpar*,
     *redefinir*, *resetar*, *reiniciar* or *zerar* for a wipe (*zerar* also means "beat the game" in
     Brazilian gaming slang). French shipped "Wipe server" as "reset" once; do not repeat it.
   - *limpar* is only for clearing a filter, a log view, a history or a selection, and for the Map
     Cleanup tool (*Limpeza do mapa*), whose English is "cleanup" too.
   - *redefinir* is reset (a password, a counter, a form). Reset to default is the game's *Restaurar
     padrão*.
8. **Server Setup vs Server Configuration vs Settings.** Three different pages, three different
   words. **Server Setup** (the new-server wizard) is *Adicionar servidor*. **Server Configuration**
   (the server.ini / sandbox editor) is *Configuração do servidor*, singular. **Settings** (panel
   preferences) is *Configurações*, plural. The French locale once gave two nav items the same
   phrase; this is how pt-BR avoids it.
9. **spawn (verb) → *gerar*; respawn → *reaparecer* or *renascer*.** The game spawns hordes and
   vehicles with *Gerar* (*Gerar Veículo*, *Gerar Horda*, *Gerar Agora*); its one *Spawnar Item*
   context-menu entry is the outlier, and we follow the majority for items too (*gerar item*). Keep
   *spawn* only in *ponto de spawn* / *região de spawn*. Loot and zombies *reaparecem* (the game's sandbox word is
   *reaparecimento*); a player *renasce* (the game's *Renascer na Base*).

## Core vocabulary

| English | pt-BR | Note |
| --- | --- | --- |
| server | servidor | the game server. In discord.json, if it could be the Discord server, say *servidor do Discord* or *servidor do jogo* |
| dedicated server | servidor dedicado | |
| the panel | o painel | this application |
| dashboard | o Dashboard | ruling 5 |
| instance | instância | |
| server profile | perfil do servidor | |
| player | jogador | |
| character / survivor | personagem / sobrevivente | the game's words |
| world | mundo | |
| map | mapa | |
| world map | mapa do mundo | the game's *Mapa do Mundo* |
| region | região | |
| cell | célula | |
| save / savegame (noun) | save | loanword table |
| save folder | pasta do save | |
| backup | backup | *fazer backup*, *restaurar backup* |
| snapshot | snapshot | |
| restore point | ponto de restauração | |
| template | modelo | |
| preset | predefinição | the game's *Predefinições Salvas*. Distinct from *modelo* |
| schedule (noun) | agendamento | |
| scheduled task | tarefa agendada | |
| scheduler | agendador | |
| console | console | |
| log | log | *log do servidor*, *logs de depuração*. Keep *registro* for "record" and *registrar* for "register" |
| debug | depuração | *logs de depuração*, *modo de depuração* |
| diagnostics | diagnóstico | one check is *uma verificação* |
| health | saúde | *saúde do sistema* |
| uptime | tempo ativo | `up {{uptime}}` → *ativo há {{uptime}}* |
| latency | latência | |
| crash (noun) | crash | the server as subject: *o servidor caiu* (the idiom). A process: *fechou inesperadamente* |
| settings (the panel's own) | configurações | always plural. Also the connection details stored in a server profile (*configurações de RCON*, the My Servers edit dialog) |
| settings (server.ini, sandbox, mod settings) | opções | the values the game server reads: *opções do servidor*, *opções do sandbox*, *opções de mods*, *{{count}} opção do sandbox*. Follows the game's *Opções do Servidor* / *Opções do Sandbox*. Never *configurações do sandbox* |
| configuration / config | configuração | singular; the server's config files |
| options | opções | *opções do servidor*, *opções do sandbox* (game) |
| update (noun) | atualização | software only; ruling 6 |
| version | versão | |
| build (game build) | build | loanword table |
| branch | branch | |
| conflict | conflito | |
| dependency | dependência | |
| file | arquivo | |
| folder | pasta | |
| directory | diretório | |
| path | caminho | |
| disk | disco | also in terse stat labels (CPU / RAM / Rede / Disco) |
| network | rede | |
| port | porta | |
| host | host | loanword table |
| IP address | endereço IP | |
| firewall | firewall | |
| port forwarding | redirecionamento de portas | |
| process | processo | |
| service | serviço | systemd / Windows service |
| environment variable | variável de ambiente | |
| permission (file system) | permissão de arquivo | say *de arquivo* when it could be read as a panel permission |
| certificate / key | certificado / chave | |
| reverse proxy | proxy reverso | |
| origin (CORS) | origem | allowlist → *origens permitidas* (ruling 3) |
| notification | notificação | |
| event | evento | |
| weather | clima | the game uses *Clima* and *Tempo*; *tempo* collides with time, so *clima* |
| climate | clima | "Severe weather" *clima severo*, "Climate trim" *ajuste climático* |
| tab | aba | |
| page | página | |
| screen | tela | |
| dialog | caixa de diálogo | usually just refer to what it does |
| step | etapa | |
| wizard | assistente | |
| overview | visão geral | |
| details / summary | detalhes / resumo | |
| history | histórico | |
| queue | fila | *na fila* |

## Page and navigation names

Other strings point at these pages ("Restore it from the Backups page"). Use exactly these names
when you do, so the reader can find the page in the sidebar.

| English (shell.json) | pt-BR |
| --- | --- |
| Dashboard | Dashboard |
| Server / World / Users / Panel (sections) | Servidor / Mundo / Usuários / Painel |
| Server Console | Console do servidor |
| Online Players | Jogadores online |
| In-Game Chat | Chat do jogo |
| Events & Weather | Eventos e clima |
| Event Console (events page title) | Console de eventos |
| World Map | Mapa do mundo |
| Server Configuration | Configuração do servidor |
| Mod Manager | Gerenciador de mods |
| Templates | Modelos |
| Scheduled Tasks | Tarefas agendadas |
| World Backups / Backups | Backups do mundo / Backups |
| Map Cleanup | Limpeza do mapa |
| My Servers | Meus servidores |
| Server Setup | Adicionar servidor |
| Browse Public Servers | Explorar servidores públicos |
| Discord | Discord |
| Panel Settings / Settings | Configurações do painel / Configurações |
| Debug Logs | Logs de depuração |
| Panel Users | Usuários do painel |
| Roles & Permissions | Cargos e permissões |
| Single Sign-On | Login único (SSO) — *Login único* where the label must be short |
| Leaderboard | Placar |
| Active Server | Servidor ativo |
| Manage Servers | Gerenciar servidores |
| Remote (badge) | Remoto (the `RM` short badge stays `RM`, like es and de) |

When a button, link or hint names one of these pages, keep the page name exactly as the sidebar
writes it, **including its capital**: *Abrir Meus servidores*, *Abrir Configurações*, *Abrir
Gerenciador de mods*, *Abrir Limpeza do mapa*, *em Configuração do servidor*, *na página Backups*.
English shorthand for a page (*Open Mods*, *the Mods page*, *Server Finder*, *Servers*) becomes the
real sidebar name (*Gerenciador de mods*, *Explorar servidores públicos*, *Meus servidores*).

Navigation hints (`A → B → C`) must name what is actually on screen. Where the English points at a
tab, field or button that does not exist under that name, the pt-BR hint names the real one (for
example the Settings tab is *Mods e Workshop*, so *Configurações → Mods e Workshop*; the Dashboard
button is *Iniciar*, so *Dashboard → Iniciar*). Report the English bug; do not copy it.

## Access control

| English | pt-BR | Note |
| --- | --- | --- |
| user | usuário | a panel account |
| account | conta | |
| role | cargo | ruling 4. *criar cargo*, *renomear cargo* |
| permission | permissão | |
| capability | permissão | one tickable row in the rights matrix; ruling 4 |
| built-in (role, template) | predefinido | |
| member | membro | |
| administrator / admin | administrador / admin | keep the short *admin* where English is short |
| moderator | moderador | |
| technician | técnico | |
| owner | proprietário | the game's word (safehouse owner) |
| sign in / log in | entrar (button) · fazer login (prose) | noun: *login* |
| sign out | sair | |
| password | senha | |
| username | nome de usuário | |
| session | sessão | |
| single sign-on | login único | *SSO* where English says SSO |
| provider (OIDC) | provedor | *provedor de identidade* |
| client ID / client secret | ID do cliente / segredo do cliente | |
| redirect URI | URI de redirecionamento | |
| claim (OIDC) | claim | a token field; never *reivindicação*, that is the safehouse verb |
| recovery code | código de recuperação | |
| recovery token / setup token | token de recuperação / token de configuração | |
| two-factor | autenticação em dois fatores (2FA) | |
| access level (in-game) | nível de acesso | the game's *Nível de Acesso* |
| grant / revoke | conceder / revogar | |
| assign | atribuir | |

**In-game access levels.** A **label** takes the game's PT-BR role name; a **value** the operator types
or a command receives stays literal and lowercase:

| English label | pt-BR label | Value (never translated) |
| --- | --- | --- |
| Admin | Admin | `admin` |
| Moderator | Moderador | `moderator` |
| Overseer | Supervisor | `overseer` (the game's B42 PT-BR says *Supervisor*) |
| GM | GM | `gm` |
| Observer | Observador | `observer` |
| User | Usuário | `user` |
| None | Nenhum | `none` |
| Staff (radio) | equipe | |

## Actions

Buttons and menu items use the **infinitive** (*Salvar*, *Excluir*, *Reiniciar servidor*), as the
game's PT-BR does. Instructions in prose use the **você imperative** (*Pare o servidor primeiro*,
*Clique em Salvar*, *Tente novamente*).

| English | pt-BR | Note |
| --- | --- | --- |
| start | iniciar | |
| stop | parar | the game's *Parar*; not *interromper*, not *deter* |
| restart | reiniciar (verb) · reinício (noun) | *reinício pendente*, *reinício automático* |
| force stop | forçar parada | Android's own PT-BR for "Force stop", familiar to every Brazilian |
| kill / force kill (a process) | encerrar / forçar encerramento | |
| shut down (graceful) | desligar com segurança | *desligamento* (noun) |
| save (verb) | salvar | *salvar o mundo* for the RCON save |
| auto-save | salvamento automático | |
| back up | fazer backup | *Fazer backup antes de apagar* |
| restore | restaurar | |
| roll back | reverter | |
| install / uninstall | instalar / desinstalar | |
| update / upgrade | atualizar | ruling 6 |
| check for updates | verificar atualizações | |
| verify (files) | verificar | |
| validate | validar | |
| enable / disable | ativar / desativar | the game's words. States: *ativado* / *desativado* |
| turn on / off (toggle) | ativar / desativar | on/off state labels: *ativado* / *desativado* |
| add | adicionar | |
| remove | remover | ruling 7 |
| delete | excluir | ruling 7 |
| wipe | apagar (+ object) | ruling 7; destructive, never softened |
| clear | limpar | ruling 7 |
| reset | redefinir | reset to default: *restaurar padrão* |
| create / edit / rename / duplicate | criar / editar / renomear / duplicar | |
| apply | aplicar | |
| cancel / close | cancelar / fechar | |
| confirm | confirmar | |
| continue / next / back / skip / finish | continuar / avançar / voltar / pular / concluir | |
| retry / try again | tentar novamente | |
| refresh / reload | recarregar | ruling 6 |
| dismiss | dispensar | a banner, warning or notification; a dismissed conflict is *dispensado* |
| ignore | ignorar | |
| download | baixar | noun: *download* |
| upload | enviar | noun: *upload* |
| import / export | importar / exportar | |
| copy / paste | copiar / colar | *Copiado* |
| browse (a folder) | procurar | *Procurar pasta* |
| browse (servers) | explorar | |
| search | pesquisar | the game's *Pesquisar*. Placeholder: *Pesquisar jogadores...* |
| filter / sort | filtrar / ordenar | |
| select / choose | selecionar / escolher | |
| preview | pré-visualizar · prévia (noun) | |
| connect / disconnect / reconnect | conectar / desconectar / reconectar | |
| join (a server) | entrar | *ao entrar no servidor* |
| register | registrar | a server profile, slash commands, a player account |
| run (a task, a command) | executar | *executar agora*; a run is *uma execução* |
| schedule (verb) | agendar | |
| trigger (an event) | disparar | *Tempestade disparada*, *disparar evento* |
| sync | sincronizar | |
| track (mods) | monitorar | *mods monitorados* |
| drag / reorder | arrastar / reordenar | |
| move to top / move to bottom | mover para o topo / mover para o final | load-order buttons |
| pin / unpin | fixar / desafixar | |
| open in new tab | abrir em nova aba | "(opens in new tab)" → *(abre em nova aba)* |
| learn more | saiba mais | |

## Status words

| English | pt-BR |
| --- | --- |
| running | em execução |
| stopped | parado |
| starting / stopping / restarting | iniciando / parando / reiniciando |
| not responding / unresponsive | sem resposta |
| online / offline | online / offline |
| installing / updating / downloading | instalando / atualizando / baixando |
| loading / saving / checking | carregando / salvando / verificando |
| pending | pendente |
| queued | na fila |
| idle | ocioso |
| succeeded / completed | concluído |
| success | sucesso |
| failed | falhou (verb) · com falha (state) |
| error | erro |
| warning | aviso |
| alert | alerta |
| enabled / disabled | ativado / desativado |
| available / unavailable | disponível / indisponível |
| not configured | não configurado |
| unknown | desconhecido |
| missing | ausente |
| duplicate | duplicado |
| healthy / degraded | saudável / degradado |
| unsaved changes | alterações não salvas |
| restart required | reinício necessário |

## Project Zomboid entities

A row that names a key in the third column is the game's exact PT-BR for that key. The other rows
follow the game's vocabulary, or say that the term is the panel's own.

| English | pt-BR | Game source / note |
| --- | --- | --- |
| zombie / zombies | zumbi / zumbis | `Sandbox_Zombie` |
| horde | horda | `IGUI_DebugContext_HordeManager` (*Gerenciador de Hordas*) |
| survivor | sobrevivente | |
| safehouse | base | ruling 2 |
| claim / release (a safehouse) | reivindicar / liberar | `ContextMenu_SafehouseClaim`, `ContextMenu_SafehouseRelease` |
| faction | facção | `IGUI_FactionUI_*` |
| faction tag | tag da facção | |
| war | guerra | |
| territory | território | |
| whitelist | lista de permissões | ruling 3 |
| ban list / banned | lista de banidos / banido | |
| kick | expulsar (verb) · expulsão (noun) | `IGUI_UserList_Kick` |
| ban / unban | banir / desbanir · banimento (noun) | `IGUI_UserList_Ban`, `IGUI_UserList_UnBan` |
| voice ban | banir do chat de voz · banimento de voz | |
| mute | silenciar | `UI_Scoreboard_Mute` |
| teleport | teleportar | `IGUI_UserList_Teleport` |
| god mode | modo Deus | *Modo Deus* in-game |
| invisible | invisível · invisibilidade | |
| heal / kill (a player) | curar / matar | |
| XP / skill / trait / profession | XP / habilidade / traço / profissão | |
| loot | saque | `UI_ServerSettingGroup_Loot`. Sandbox loot labels: use the game's exact string, which is often *itens* (*Raridade dos itens*) |
| loot respawn | reaparecimento de itens | `Sandbox_LootRespawn` |
| zombie respawn | reaparecimento de zumbis | `Sandbox_ZombieRespawn` |
| respawn (player) | renascer | `IGUI_SafehouseUI_Respawn` |
| spawn (verb: horde, vehicle, item) | gerar | ruling 9 |
| spawn point / spawn region | ponto de spawn / região de spawn | `IGUI_DebugContext_SpawnPoints`, `UI_ServerSettingGroup_SpawnRegions` |
| item | item, itens | |
| vehicle | veículo | |
| trunk / alarm / siren | porta-malas / alarme / sirene | |
| repair | reparar | the game's word; not *consertar* |
| meta event | metaevento | `Sandbox_MetaEvent` |
| helicopter event | evento de helicóptero | |
| power / water / electricity shutoff / water shutoff | energia / água / corte de energia / corte de água | `Sandbox_ElecShut`, `Sandbox_WaterShut` |
| utilities (power & water) | energia e água | |
| erosion | erosão | |
| basement | porão | map floor badge `B{{n}}` → `S{{n}}` (*subsolo*, what Brazilian lifts show; es and fr do the same) |
| floor (z-level) | andar | |
| rain / storm / tropical storm / blizzard | chuva / tempestade / tempestade tropical / nevasca | |
| fog / wind / clouds / humidity | névoa / vento / nuvens / umidade | `IGUI_climate_Fog`, `IGUI_ClimateOptions_HUMIDITY`. Fog in **weather/events** context (events.json climate controls, settings) is *névoa*. Fog in **sandbox** context is *nevoeiro*, because the game's own `Sandbox.json` says *Ciclo de Nevoeiro* / *Intensidade Máxima de Nevoeiro* and the sandbox labels are copied verbatim; serverconfig descriptions of those options say *nevoeiro* too. Never *neblina* |
| lightning / thunder | relâmpago / trovão | |
| gunshot / noise | tiro / ruído | |
| game speed / time speed | velocidade do jogo / velocidade do tempo | |
| zombies killed | zumbis mortos | `IGUI_char_Zombies_Killed` |
| kills (leaderboard) | abates | the panel's own word (the game only has *zumbis mortos*): *abates atuais*, *abates totais* |
| deaths | mortes | |
| days survived | dias sobrevividos | |
| favorite weapon | arma favorita | `IGUI_char_Favourite_Weapon` |
| scoreboard / leaderboard | placar | `IGUI_AdminPanel_MiniScoreboard` (*Placar Compacto*) |
| tickets | chamados | `IGUI_AdminPanel_SeeTickets` |
| server message / broadcast | transmissão · transmitir | `IGUI_CapabilitiesTooltips_DisplayServerMessage`. Quick broadcasts: *transmissões rápidas* |
| announce / announcement | anunciar / anúncio | |
| admin panel (in-game) | painel administrativo | |
| sandbox options | opções do sandbox | `IGUI_AdminPanel_SandboxOptions` |
| server options | opções do servidor | |
| zombie lore | características dos zumbis | `Sandbox_ZombieLore` |
| player dossier (the panel's player card) | ficha do jogador | the panel's term, not the game's |
| roster (known, currently offline players) | histórico | the players-page tab |

## Mods and Workshop

| English | pt-BR | Note |
| --- | --- | --- |
| mod | mod | o mod |
| Workshop / Steam Workshop | Workshop / Workshop da Steam | ruling 1; *a Steam* is feminine too |
| Workshop item | item da Workshop | |
| Workshop collection | coleção da Workshop | |
| Workshop ID | ID da Workshop | ruling 1 |
| Mod ID / mod IDs | ID do mod / IDs de mod | |
| load order | ordem de carregamento | the game's *Ordem de carregamento dos mods* |
| Mod Manager | Gerenciador de mods | |
| installed / tracked | instalados / monitorados | |
| enabled mods | mods ativos | |
| variant | variante | |
| add-on | complemento | |
| overlap / overlapping files | sobreposição / arquivos sobrepostos | |
| override (a file wins over another) | sobrescrever | |
| severity: critical / medium / low | gravidade: crítica / média / baixa | |
| false positive | falso positivo | |
| orphan | órfão | |
| map mod | mod de mapa | |
| sync Mod IDs | sincronizar IDs de mod | |

## Discord and PanelBridge

| English | pt-BR | Note |
| --- | --- | --- |
| Bot (the Discord bot) | bot | |
| bot token | token do bot | |
| Guild (Server) ID / Guild ID | ID do servidor (Guild) | both English forms; keep the Guild parenthetical, Discord's own Developer Portal term |
| Intents / Privileged Gateway Intents | Intents / Privileged Gateway Intents | literal Developer Portal checkbox names |
| Developer Portal | Developer Portal | the page is English-only. *Portal do Desenvolvedor do Discord* only in running prose if needed |
| application (Discord app) | aplicativo | |
| channel | canal | |
| role (Discord) | cargo | ruling 4 |
| slash command | comando de barra | Discord's own PT-BR |
| permission tier | nível de permissão | |
| chat relay | retransmissão do chat · retransmitir | |
| webhook | webhook | |
| bridge (generic, lowercase) | ponte | *a ponte*, *configurações da ponte*, *ponte offline* |
| bridge mod | mod da ponte | |
| PanelBridge | PanelBridge | **one word always**; where English writes "Panel Bridge" as a title, still *PanelBridge* |
| GM | GM | do not expand |

**Literal labels of an English-only UI stay in English.** The Discord Developer Portal is not
localised, so its permission names (`Send Messages`, `Embed Links`, `Read Message History`,
`Use Slash Commands`) and buttons (`Reset Token`, `Copy`, `Bot Permissions`) stay in English, inside
whatever tags or quotes English gives them. Translate the sentence around them. For a UI that **is**
localised on a Brazilian machine (Windows, Steam), use its real PT-BR label only if you are sure of
it; otherwise keep the English label.

## Style rules

- **Address the reader as *você*.** *Você pode tentar novamente*, *seu servidor*. Never *tu*, never
  *o senhor*, never *vocês* (the panel talks to one operator). This is a tool someone runs for their
  friends' game server, not enterprise software.
  **One exception: text the panel sends *to the players*** (preset broadcasts, quick broadcasts,
  scheduled server messages in chat.json, console.json, scheduler.json, events.json). Those address
  everyone on the server, so they use the plural: *Bem-vindos ao servidor!*, *Salvem o progresso!*,
  *Leiam as regras*, *Desconectem-se, por favor*, *Corram!*. Labels and descriptions *about* those
  messages still talk to the operator in the singular.
- **Instructions take the *você* imperative**, which is the subjunctive form: *Pare o servidor
  primeiro*, *Clique em Salvar*, *Verifique a senha*, *Tente novamente*. Not *Para o servidor*
  (that is the *tu* form and reads as a mistake in Brazil).
- **Buttons, menu items and tab labels take the infinitive**: *Salvar*, *Excluir backup*, *Forçar
  parada*, *Adicionar à lista de permissões*. Not *Salve*, not *Exclua*.
- **Pure state statements stay impersonal**: *Não foi possível carregar a configuração*, *O
  servidor está parado*. No one to address, so do not invent a *você*.
- **Sentence case, even where English uses Title Case.** English writes "Add to Whitelist", "Set
  Access Level", "Safehouse Snapshot Created"; pt-BR is *Adicionar à lista de permissões*, *Definir
  nível de acesso*, *Snapshot da base criado*. Capitalise only the first word, proper nouns
  (Project Zomboid, Steam, Workshop, Discord, PanelBridge, Knox, Muldraugh), acronyms, and *Deus*.
  Weekdays and months are lowercase inside a sentence (*segunda-feira*, *janeiro*) and capitalised
  only as the first word of a standalone label. If the English value is ALL CAPS on purpose (an
  eyebrow like `// LIVE · SURVIVAL RANKINGS`), mirror it: `// AO VIVO · RANKING DE SOBREVIVÊNCIA`.
- **Accents are mandatory**, including on capitals (*Área*, *Íntegro*, *Ótimo*). A missing accent is
  a typo, not a variant. Post-2009 spelling: *ideia*, *voo*, *linguiça*, no trema.
- **Crase is not optional**: *à lista*, *às 18h*, *Adicionar à lista de permissões*. No crase before
  a placeholder whose gender you do not know (see the next section).
- **Acronyms stay upper case** (RCON, GM, INI, OIDC, SSO, RAM, CPU, ID), even where English writes a
  terse lowercase badge. Plural of ID is *IDs*. The exception is a string imitating a literal
  command or prompt (`rcon $`, `/rcon`).
- **Punctuation.** Mirror English: trailing period, colon, question mark, `…` versus `...`, emoji,
  arrows. No space before `?`, `!`, `:`. Quotation marks follow the English value (straight `"`
  stays straight, escaped as `\"` inside JSON; curly “ ” stays curly). Never « ».
- **Leading and trailing spaces in an English value are load-bearing.** Values like
  `" ({{stripped}} mod ID stripped from INI)."` or `" {{count}} player(s) will be disconnected!"`
  are suffixes glued onto another string. Keep the same leading/trailing whitespace.
- **`&` in a label becomes *e*** (*Mapa e terreno*, *Contas e banimentos*). Leave `&` alone inside
  code, commands and URLs. HTML entities such as `&lt;action&gt;` must appear exactly as in English.
- **e.g.** → *ex.:* · **i.e.** → *ou seja* · **etc.** → *etc.* · **vs** → *vs.*
- **Keep destructive wording destructive.** A wipe or delete confirmation that sounds mild in
  Portuguese when it was alarming in English is a bug, not a translation choice. *Isso exclui
  permanentemente…*, *não é possível desfazer*.
- **Confirmations**: *Tem certeza de que deseja excluir "{{name}}"?* (the game's own confirmation
  form). Keep them short; the panel's English already says what happens next.
- **Errors say what happened, then what to do.** Common English shapes:

  | English | pt-BR |
  | --- | --- |
  | Could not X / Couldn't X | Não foi possível X |
  | Failed to X | Falha ao X |
  | X failed (a toast or dialog title) | Falha em X / Falha ao X · with a placeholder: *Falha: {{action}}* |
  | Unable to X | Não foi possível X |
  | Try again. | Tente novamente. |
  | … requires the backups.manage permission, which this role doesn't have. | … requer a permissão backups.manage, que este cargo não tem. |
  | Ask an administrator for access. | Peça acesso a um administrador. |

- **Length is a real constraint.** Portuguese runs about 20–30% longer than English. On buttons,
  badges, table headers, tabs and chips pick the shortest correct wording (*Parar*, not *Parar o
  servidor agora*), and drop articles in labels (*Salvar configuração*, not *Salvar a
  configuração*).
- **Keyboard keys keep their English legend.** Brazilian ABNT2 keyboards print *Ctrl*, *Shift*,
  *Alt*, *Enter*, *Esc*, *Tab*, *Del*. Anything inside `<kbd>` is left exactly as English. In prose,
  "arrow keys" is *setas* and "Space" is *Espaço*.

## Time, numbers and units

- **Relative time** puts *há* in front: `{{count}}s ago` → `há {{count}}s`, `{{count}}m ago` →
  `há {{count}} min`, `{{count}}h ago` → `há {{count}} h`, `{{count}}d ago` → `há {{count}} d`,
  "just now" → *agora mesmo*. "for {{count}}m" → *por {{count}} min*. "in {{time}}" (future) → *em
  {{time}}*.
- **Unit spacing, one rule everywhere.** Only **seconds** stay glued to the number, as in English
  (`{{seconds}}s`, `há {{count}}s`, `em {{seconds}}s`). **Minutes, hours and days take a space**:
  `{{count}} min`, `{{count}} h`, `{{count}} d` (and `em {{hours}} h {{minutes}} min`). Minutes are
  always *min*, never a bare *m* (in Portuguese *m* reads as metres).
- **Clock times use 24-hour style in prose** (*às 18h*, *18:00*). Where a value already comes
  formatted, or is the game's own option label (`7 AM` in sandbox start time), leave it as supplied.
- **Numbers and dates are formatted by code.** Never hard-code a decimal comma or a date order
  around a placeholder. `MB`, `GB`, `ms` stay as they are, with the same spacing as English
  (`({{mb}} MB)`, `(~3 GB)`).
- **"player(s)" shapes** keep the same trick: *jogador(es)*, *arquivo(s)*, *mod(s)*.

## The trap specific to Portuguese: gender, contractions and the singular zero

English `Deleted {{name}}` and `Restore {{name}} onto {{serverName}}` carry no gender. Portuguese
carries gender on the article, the adjective, the participle, **and on every preposition that
contracts with an article** (*do/da*, *no/na*, *ao/à*, *pelo/pela*).

- **A placeholder that substitutes a noun breaks every word agreeing with it.** `O {{item}} foi
  excluído` is wrong the moment `{{item}}` is *a coleção*. Rewrite so nothing agrees with the
  substituted word, usually with a colon: *Excluído: {{item}}*, *Falha: {{action}}*. Do not guess a
  gender.
- **Never contract a preposition with a placeholder.** Use *de {{name}}*, *em {{serverName}}*,
  *para {{player}}*, never *do {{name}}*, *no {{serverName}}*, *à {{role}}*. `Restore <1>{{name}}</1>
  onto <3>{{serverName}}</3>` → *Restaurar <1>{{name}}</1> em <3>{{serverName}}</3>*. When the noun
  is spelled out, contract normally: *no servidor {{serverName}}*, *do cargo "{{role}}"*. Adding
  the noun is usually the cleanest fix.
- **Capability labels are substituted into sentences.** `roles.json`'s `capabilities.<key>.label`
  values are also inserted into error messages through `{{action}}` / `{{capability}}` (see
  `CAPABILITY_KEY_PARAM_NAMES` in `errorMessage.ts`). Write each label so it reads correctly on its
  own after a colon, and write those errors with a colon: *Depois desta alteração, ninguém mais
  teria a permissão: {{action}}*.
- **pt-BR treats zero as singular.** CLDR's rule for pt-BR puts 0, 1 and fractions below 2 in the
  `one` category: `Intl.PluralRules('pt-BR').select(0) === 'one'`. So a `_one` string is also what
  the screen shows for zero. Write `_one` as a genuine singular that still reads correctly with 0
  (*{{count}} jogador online*), and never hard-code *um* / *uma* / *1* in place of `{{count}}`.
- **`_one` and `_other` must genuinely differ** where Portuguese inflects (*{{count}} mod
  atualizado* / *{{count}} mods atualizados*). Keep exactly the English key set (`_one`, `_other`).
  **Do not add `_many`**; a later mechanical step adds the extra CLDR category pt-BR needs.
- **Keep exactly the English placeholder set, per key.** If an English `_one` value omits `{{count}}`
  (for example `conflictsPanel.json` `warningsCount_one = "warning"`), the Portuguese `_one` omits it
  too: the parity test fails a translation that introduces a placeholder English does not supply.
- **If a string cannot be made agreement-safe without changing what it says, stop and report it.**
  That is a server-side variant problem (two sentences), not something to fix in the locale file.

## sandboxPz.json and the sandbox labels in serverconfig.json

- **`sandboxPz.json` is extracted, not translated.** It holds Project Zomboid's own sandbox option
  and option-value labels, verbatim from the game's `Sandbox.json`, and
  `client/scripts/extract-pz-sandbox-ground-truth.mjs` generates it for every language that has a
  mapping in its `LANG_MAP`. For pt-BR the source folder is `PTBR`. The game's text is copied as is,
  including its Title Case (*Quantidade de Zumbis*, *Muito Alta*), because the operator compares
  it against the in-game sandbox screen.
- **In `serverconfig.json`, `sandboxSettings.*.label` and `sandboxSettings.*.options.*.label` copy
  the pt-BR `sandboxPz.json` value for the same setting**, exactly, as the zh-CN locale does. Every
  one of them has a `sandboxPz` twin at the same path. (`translatedSandboxLabel()` in
  `serverConfigSchema.ts` shows the `serverconfig` label whenever it differs from English, so an
  independently-worded label here would hide the game's own wording.)
  `sandboxSettings.*.description` is the panel's own text: translate it normally, borrowing
  vocabulary from the game's `Sandbox_*_tooltip` strings.
- **`serverconfig.json` `iniSettings.*`** are the panel's own labels and descriptions for server.ini
  keys (the game has tooltips for these, `UI_ServerOption_<Key>_tooltip` in `UI.json`, but no
  labels). Translate them in sentence case, using the game's tooltip vocabulary. The key itself
  (`PublicName`, `Open`) never changes.

## Terms coined during the pt-BR pass

Add a row here, in the same commit, when you decide a term that will recur. If you are about to coin
one of these differently, do not.

| English | pt-BR | Note |
| --- | --- | --- |
| server / sandbox / mod settings (server.ini, SandboxVars) | opções | see the core vocabulary row. *Opções do servidor*, *opções do sandbox*, *opções de mods*; *configurações* stays for the panel's Settings page and for connection details in a server profile |
| Saved Configs (serverconfig) | Configurações salvas | the Server Configuration feature (*uma configuração salva*, *Excluir configuração salva*). Any other namespace that names it uses this exact wording |
| Form / Raw (editor modes) | modo Formulário / modo Texto | the serverconfig toggle is *Formulário* / *Texto*. "structured editor" → *modo Formulário*; "raw editor (tab)" → *modo Texto*. *Bruto* only for raw data (*resposta bruta*, *bytes brutos*, *comando bruto*) |
| anti-cheat | antitrapaça | the game's word (*Proteção antitrapaça*) |
| PvP safety (toggle) / Safety System | modo seguro / sistema de segurança | the game's words (serverconfig `pvp.*`) |
| scan (content analysis: mod conflicts, map chunks, Workshop folder) | analisar · análise | *Analisar novamente*, *Falha na análise*, *Analisador de conflitos de mods* |
| scan (discovery: item/vehicle catalog, folder scan for server installs, public server list) | escanear · varredura | *Escanear itens*, *Escanear novamente*, *Varredura automática*, *Falha na varredura* |
| scan (a check: process detection, lock files, save size, "Scan for Updates") | verificar · verificação | *Verificar atualizações*, *a verificação de processos* |
| airdrop / supply drop | lançamento de suprimentos | *Suprimentos lançados*, *Falha no lançamento de suprimentos*. Not the loanword *airdrop* |
| drop (an airdrop or item package on the map) | lançar · lançamento | *Lançar*, *Lançar agora*, *Repetir último lançamento*. *Soltar* is the game's word for dropping an item from the inventory; do not use it for airdrops |
| launcher (panel / game-server launcher) | inicializador | *o inicializador protegido do Linux*, *Modo de inicializador personalizado*. Not the loanword *launcher* |
| container (Docker) | contêiner | *o contêiner Docker*, *recriar o contêiner* |
| container (in-game) | recipiente | the game's word (*Limite de itens por recipiente*) |
| refresh token | token de renovação | *tokens de acesso e de renovação*. Not *token de atualização* (ruling 6) |
| lock file / stale lock file | arquivo de bloqueio / arquivo de bloqueio obsoleto | *Excluir arquivos de bloqueio obsoletos*; the literal `.lock` extension stays |
| Controlled Folder Access (Windows) | Acesso controlado a pastas | Windows' own PT-BR name |
| untrack / remove from tracking | deixar de monitorar / remover do monitoramento | button *Deixar de monitorar*; confirms *Remover do monitoramento…*; participle "untracked" → *removido do monitoramento* |
| Missing from collection / Not on server / Tracked only / In sync | Fora da coleção / Fora do servidor / Apenas monitorado(s) / Sincronizado(s) | Workshop collection sync filters and status chips (settings.json and workshopCollectionPanel.json use the same words) |
| Clear Installation Folder | Esvaziar pasta de instalação | it deletes the folder's contents; *limpar* is reserved (ruling 7). Quoted the same way in roles.json |
| RCON password / port / host / connection | senha RCON / porta RCON / host RCON / conexão RCON | RCON is an attributive modifier, no *do*: *Senha RCON*, *a porta RCON*, *Falha na conexão RCON*. *Configurações de RCON* for the group of connection settings |
| chat bridge (Discord) | ponte de chat | *ponte de chat bidirecional*. "chat relay" stays *retransmissão do chat* |
| Developer Mode (Discord client) | Modo de desenvolvedor | the Discord client's PT-BR label |
| file watcher / the watcher (PanelBridge) | monitor de arquivos / o monitor | *inicia o monitor* |
| Zoom in / Zoom out | Aumentar zoom / Diminuir zoom | map controls on World Map and Map Cleanup |
| Server Finder (feature) | a página Explorar servidores públicos | it is the Browse Public Servers page |
| Stable (branch) | estável, in sentence case | *Público (estável)*, *Build 42 (estável)*, *Beta instável* |
| This cannot be undone. / This action cannot be undone. | Não é possível desfazer. / Não é possível desfazer esta ação. | one wording for the stock sentence. Sentences with their own subject (*A exclusão não pode ser desfeita*) can differ |
| Mod ID: "the mod's ID" vs "a mod ID" | ID do mod / ID de mod | *ID do mod* for a field label or one specific mod's ID (*Formato de ID do mod inválido*); *ID de mod* for the generic or counted noun (*{{count}} ID de mod*, *nenhum ID de mod*). Plural always *IDs de mod* |
| data freshness ("Updated {{time}}", "updated 5m ago") | recarregado | the panel re-read the data: *Recarregado às {{time}}*, *recarregado há {{count}} min* (ruling 6). *Atualizado em {{date}}* is allowed only for the generation timestamp of a data snapshot (leaderboard) or of a software build (Steam branch), and for catalog refresh toasts (*Catálogo de itens atualizado*). A value the operator changed is *alterado* / *salvo* / *ajustado*, never *atualizado* |
| toast titles with an implicit subject | masculine singular participle | *Aplicado*, *Excluído*, *Salvo*, *Copiado*, even when the implied noun is feminine. With a named object, agree or use the colon form (*Configuração salva*, *Excluído: {{name}}*) |
| "{{action}} was sent, but the mod could not confirm…" (PanelBridge result toasts) | *{{action}}: comando enviado, mas o mod não conseguiu confirmar se teve efeito.* | the same wording in events, players, serverconfig and worldMap. The "old bridge" variant is *{{action}}: pode ter funcionado, mas esta versão do mod PanelBridge não informa se deu certo. …* |
