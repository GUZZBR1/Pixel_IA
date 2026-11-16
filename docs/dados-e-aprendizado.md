# Dados, aprendizado e contexto

## Uso de partidas históricas

Registros de PixelCanvas, r/place e experiências semelhantes podem ajudar a estudar estratégias de desenho, coordenação, negociação e disputa. Quando houver dados de canvas e chat associados, eles podem ser tratados como episódios: contexto inicial, mensagens, ações visuais, mudanças de estratégia e resultado.

Um episódio é uma demonstração do que ocorreu, não uma regra dizendo o que todos os agentes devem fazer. Por exemplo, um episódio de guerra pode ilustrar negociação, defesa, ataque e consequências; não deve instruir o agente a iniciar guerras sempre que encontrar um desacordo.

## Separar regra, objetivo e exemplo

- **Regras do ambiente:** ações permitidas e validação do servidor.
- **Identidade e objetivos:** preferências configuradas para cada agente.
- **Episódios de referência:** exemplos opcionais de estratégias e interações.
- **Aprendizado:** processo controlado de avaliar e eventualmente mudar comportamento.

Essa separação evita que texto de dataset ou mensagens de partida sejam interpretados como autoridade para alterar as regras.

## Abordagem recomendada por etapa

### MVP

Não treinar o modelo com os datasets. Começar com identidades configuráveis, regras simples e histórico da partida. Primeiro validar se agentes conseguem usar o canvas e o chat de forma interessante.

### Experimentos posteriores

- **Recuperação de episódios:** buscar exemplos relevantes quando o agente toma uma decisão. É uma forma de dar contexto sem retreinar o modelo.
- **Aprendizado por imitação:** treinar com demonstrações selecionadas e rotuladas de ações e conversas.
- **Self-play:** colocar agentes com estratégias diferentes para jogar entre si.
- **Aprendizado por reforço:** testar recompensas explícitas por objetivos do jogo, acompanhando comportamentos indesejados.
- **Aprendizado contínuo/online:** avaliar atualizações frequentes a partir de novas partidas. Não deve ser presumido como necessário nem ativado sem avaliação.

## Redução de viés e repetição

- Registrar a origem, data, licença e contexto de cada conjunto de dados.
- Filtrar spam, duplicatas, conteúdo fora de contexto e episódios sem sequência confiável.
- Manter múltiplos resultados e estratégias, incluindo falhas, negociações e cooperação.
- Testar em mapas, paletas, regras e cenários não vistos durante a preparação dos exemplos.
- Medir repetição visual e diversidade de comportamento entre agentes.
- Comparar resultados com e sem recuperação de exemplos para entender sua influência.
- Não otimizar apenas para vencer ou ocupar território; isso pode incentivar estratégias destrutivas e repetitivas.

## Contexto de notícias e redes sociais

Integrações com X ou outras redes ficam fora do MVP. Em uma etapa futura, conteúdo externo deve passar por coleta seletiva, deduplicação, resumo com fonte e data e apresentação como informação não confiável. O conteúdo pode inspirar temas, mas não deve acionar automaticamente guerras ou alterar regras.

Posts, notícias e mensagens podem conter boatos, instruções maliciosas ou tentativas de manipular agentes. Devem ser tratados como dados, sem acesso a ferramentas ou credenciais externas. Qualquer publicação do agente fora do jogo exigiria uma decisão de produto separada.

## Ciclo controlado de avaliação

```text
partidas → episódios rotulados → avaliação de qualidade e diversidade
     → seleção de exemplos → experimento controlado
     → comparação com baseline → adoção ou descarte da mudança
```

Guardar mais dados não significa automaticamente que o agente aprendeu. Cada mudança deve ser comparada a uma versão de referência, verificando se melhora coordenação e variedade sem aumentar repetição, comportamento incoerente ou desrespeito às regras.
