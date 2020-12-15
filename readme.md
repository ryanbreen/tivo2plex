# TiVo2Plex

Given files exported from cTiVo, convert them to mp4s, embed metadata, and move into a Plex library.

## Prerequisites

For this to work, you need the following on your PATH:

* comskip
* ffmpeg
* mediainfo

## Getting Started

NB: I've only run this on a modern Ubuntu, so YMMV on other platforms.

### Getting Files out of cTiVo

In my workflow, I expose a network share named `space` from the Linux box to my Mac.  The share points to `/space/tivo/`, and within that I have the directory `/kids/tv`.

On my Mac, I mount `space` and point cTiVo at `/Volumes/space/tivo/kids` if I want to export TV shows for the kids (cTiVo being smart enough to segment `tv` from `movies` and store episodes at paths based on show and season, assuming you tell it to).

### cTiVo Configuration

1. Set General Option "Show Shows in Folders"
2. Set Advanced Option "Export Metadata to pyTiVo .TXT file"
3. Make sure the first part of the "Filename Template" in Advanced Options matches the name of the directories you'll use for `tv` and `movies`.  I've changed mine from the default because I prefer lower-case paths.  Here's mine: `["tv" / MainTitle / "Season " Season | Year / MainTitle " - " SeriesEpNumber | OriginalAirDate ["-" ExtraEpisode][" - " EpisodeTitle | Guests]]["movies"  / MainTitle " (" MovieYear ")"]`

### Running TiVo2Plex

1. Edit lib/config.json with your local paths.
2. Run `node lib/converter.js`
3. Download a show from cTiVo.  As soon as it lands, processing should begin.

## Future Plans

- [ ] Support multiple relative paths so that I can export tv shows and movies for my two sets of libraries in Plex (parents and kids, in my case).