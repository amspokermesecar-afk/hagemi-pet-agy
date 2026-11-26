# Notices

## Two licenses

| What          | Where                                             | License                                                               |
| ------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| Source code   | everything except the art below                   | [MIT](LICENSE)                                                        |
| Character art | `sidecars/pet/art/`, `assets/`, `docs/poses.webp` | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |

The art license is **non-commercial** and **share-alike**. The code can be reused under MIT, but anything
that includes this art must stay non-commercial, credit the sources below, and be shared under the same terms.
To use the code commercially, replace the art.

## Inspiration

This project is inspired by [CrossPet](https://github.com/lokicorvus/crosspet), © lokicorvus and CrossPet contributors, whose
code is under the MIT License and whose artwork is under CC BY-NC-SA 4.0. No CrossPet code is copied here; its pose set and its
mapping of agent tools to poses informed the design.

Fork enhancements (`Lihyuu/hagemi-pet-agy`) build on [KCFindstr/hagemi-pet-agy](https://github.com/KCFindstr/hagemi-pet-agy), and autonomous activity cycles, walking locomotion concepts, and clickable notifications were inspired by [dsh-pet](https://github.com/PC2005-cloud/dsh-pet).

## Art credits

The pose illustrations come unchanged from the Gemini character in
[CrossPet](https://github.com/lokicorvus/crosspet) (`characters/gemini`, commit `6e98970`), © lokicorvus and
CrossPet contributors, CC BY-NC-SA 4.0. CrossPet redrew them with AI image tools from the community's Gemini-musume
design (cat ears, heterochromatic eyes, four-point star ornament). As CrossPet's license notes, rights in community
designs remain with their original sources. The catgirl version is associated with
[ZipZipPipe](https://www.bilibili.com/opus/1233069202138464289) on Bilibili.

**Changes made here:** files in `sidecars/pet/art/blink/`, `tail/`, `under/` and `cut/`, and `assets/logo.png`, are
adaptations of those illustrations. Blink patches paint out the open eyes and composite the closed eyes from the `yawn` pose.
Tail layers are cut from each pose along the ink. Under layers are the art hidden behind the tail, generated with the LaMa
inpainting model ([Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX), Apache-2.0) and, on 37 poses, refined with
[Animagine XL 4.0](https://huggingface.co/cagliostrolab/animagine-xl-4.0) (CreativeML Open RAIL++-M). Neither model is distributed here.
Leftover white background in gaps around the tail is removed. `docs/poses.webp` is a
contact sheet of the poses. They carry the same license.

**Fork adaptations (`Lihyuu/hagemi-pet-agy`):** non-commercial character walking sprite adaptations (`sidecars/pet/art/walk_1.webp`, `blink/walk_1.webp`, `tail/walk_1.webp`, `under/walk_1.webp`, `cut/walk_1.webp`) and articulated 3/4 leg puppet cutouts (`sidecars/pet/art/limbs/walk_1_leg_*.webp`) are derived from the original character design in [KCFindstr/hagemi-pet-agy](https://github.com/KCFindstr/hagemi-pet-agy) and distributed under the same [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) license.

If you are an original author and object to any of this, please open an issue and it will be changed or removed.

## Persona

Hagemi's personality draws on running jokes in the Chinese fan community (哈基米, 极其猫, Nano Banana, and the
AI-girl rivalries seen in Bilibili videos). All dialogue here was written for this project.

## Trademarks

Gemini, Google and Antigravity are trademarks of Google LLC. Claude is a trademark of Anthropic. GPT and ChatGPT are
trademarks of OpenAI. DeepSeek is a trademark of its owner. This is an unofficial fan project, not affiliated with or
endorsed by any of them.
