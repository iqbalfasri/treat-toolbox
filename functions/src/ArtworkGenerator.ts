import { logger } from "firebase-functions";
import { storage } from "../models/firebase";
import {
  Collection,
  Collections,
  Conflicts,
  Trait,
  Traits,
  TraitValue,
  TraitValues,
  ImageLayer,
  ImageLayers,
  OrderedImageLayer,
  TraitValuePair,
  ImageComposite,
  ImageComposites,
  Conflict,
  ConflictResolutionType,
} from "../models/models";

const path = require("path");
const os = require("os");
const fs = require("fs");
const tempDir = os.tmpdir();

const TRAITVALUES_RARITY_MAX_PRECISION: number = 4;

export class ArtworkGenerator {
  projectId: string;
  collectionId: string;
  compositeGroupId: string;
  traitSetId: string | null;
  startIndex: number;
  endIndex: number;
  batchSize: number;
  isFirstBatchInTraitSet: boolean;

  constructor(
    projectId: string,
    collectionId: string,
    compositeGroupId: string,
    traitSetId: string,
    startIndex: number,
    endIndex: number,
    batchSize: number,
    isFirstBatchInTraitSet: boolean
  ) {
    this.projectId = projectId;
    this.collectionId = collectionId;
    this.compositeGroupId = compositeGroupId;
    this.traitSetId = traitSetId == "-1" ? null : traitSetId;
    this.startIndex = startIndex;
    this.endIndex = endIndex;
    this.batchSize = batchSize;
    this.isFirstBatchInTraitSet = isFirstBatchInTraitSet;
  }

  async generate(): Promise<(ImageComposite | null)[]> {
    logger.info(
      "Generate Artwork for project: " +
        this.projectId +
        " collection: " +
        this.collectionId
    );

    // fetch the specified collection / trait
    const result = await Promise.all([
      Collections.withId(this.collectionId, this.projectId),
      Traits.all(this.projectId, this.collectionId, this.traitSetId),
      ImageLayers.all(this.projectId, this.collectionId, this.traitSetId),
      Conflicts.all(this.projectId, this.collectionId, this.traitSetId),
    ]);

    const collection = result[0];
    const traits = result[1];
    const imageLayers = result[2];
    const conflicts = result[3];

    const traitValueIdToImageLayers: { [traitValueId: string]: ImageLayer } =
      {};
    imageLayers.forEach((imageLayer) => {
      if (imageLayer.traitValueId) {
        traitValueIdToImageLayers[imageLayer.traitValueId] = imageLayer;
      }
    });

    const valuesWithImagesInTraitSet = Object.keys(traitValueIdToImageLayers);

    let traitValues: { [traitId: string]: TraitValue[] } = {};

    // prefetch all trait values
    for (let i = 0; i < traits.length; i++) {
      const trait = traits[i];
      traitValues[trait.id] = await TraitValues.all(
        this.projectId,
        this.collectionId,
        this.compositeGroupId,
        trait,
        valuesWithImagesInTraitSet
      );
    }

    const projectDownloadPath = this.projectDownloadPath();

    // setup only necessary at the beginning of a run,
    // so only do this for batchNum = 0
    if (this.startIndex == 0) {
      // create download directory for all images
      await fs.promises.mkdir(
        projectDownloadPath,
        { recursive: true },
        (err: Error) => {
          if (err) {
            logger.error("error creating project directory");
            logger.error(err);
          }
        }
      );

      const layerDownloadPath = this.layerDownloadPath();

      // create download directory for all artwork
      await fs.promises.mkdir(
        layerDownloadPath,
        { recursive: true },
        (err: Error) => {
          if (err) {
            logger.error("error creating layers directory");
            logger.error(err);
          }
        }
      );
    }

    if (this.isFirstBatchInTraitSet) {
      // predownload all uncomposited artwork
      await Promise.all(
        imageLayers.map((imageLayer) => this.downloadImageFile(imageLayer))
      );
    }

    // generate artwork for each item in the collection supply
    let composites: (ImageComposite | null)[] = [];

    logger.info("Generating: " + this.startIndex + " - " + this.endIndex);
    logger.info("Trait Set: " + this.traitSetId);
    logger.info("Matching Traits: " + traits.length);
    logger.info("Matching Trait Values: " + Object.values(traitValues).length);
    logger.info("Matching Image Layers: " + imageLayers.length);

    if (traits.length == 0) {
      logger.info("no matching traits");
      return [];
    }

    if (Object.values(traitValues).length == 0) {
      logger.info("no matching trait values");
      return [];
    }

    if (imageLayers.length == 0) {
      logger.info("no matching image layers");
      return [];
    }

    let i = this.startIndex;
    while (i < this.endIndex) {
      const compositeData = await this.generateArtworkForItem(
        i,
        collection,
        traits,
        traitValues,
        traitValueIdToImageLayers,
        imageLayers,
        conflicts,
        projectDownloadPath
      );

      if (!compositeData) {
        console.log("no composite data");
        continue;
      }

      const composite = await ImageComposites.create(
        compositeData,
        this.projectId,
        this.collectionId,
        this.compositeGroupId
      );

      composites.push(composite);

      // remove any possible values for always unique traits
      // so that they can only be used once
      traitValues = this.removeUsedAlwaysUniqueTraitValues(
        traits,
        traitValues,
        composite
      );

      i++;
    }

    // only do cleanup if we just finished the last batch of the run
    if (this.endIndex == collection.supply) {
      // delete all downloaded images and composites
      await fs.promises.rmdir(
        projectDownloadPath,
        { recursive: true, force: true },
        (err: Error) => {
          if (err) {
            logger.error("directory cleanup failed");
            logger.error(err.message);
          }
        }
      );
    }

    return composites;
  }

  async generateArtworkForItem(
    itemIndex: number,
    collection: Collection,
    traits: Trait[],
    traitValues: { [traitId: string]: TraitValue[] },
    traitValueIdToImageLayers: { [traitValueId: string]: ImageLayer },
    imageLayers: ImageLayer[],
    conflicts: Conflict[],
    projectDownloadPath: string
  ): Promise<ImageComposite | null> {
    let traitValuePairs: TraitValuePair[] = [];

    let hasUnusedTraitValuePair = false;

    const numRetries = 20;
    let retriesRemaining = numRetries;
    let failedToFindUnusedTraitPair = false;

    while (!hasUnusedTraitValuePair) {
      // generate a pair mapping trait to a random trait value
      traitValuePairs = await this.randomTraitValues(traits, traitValues);

      const hash = ImageComposites.traitsHash(traitValuePairs);
      hasUnusedTraitValuePair = await ImageComposites.isUniqueTraitsHash(
        hash,
        this.projectId,
        this.collectionId,
        this.compositeGroupId
      );

      retriesRemaining--;

      if (retriesRemaining == 0) {
        failedToFindUnusedTraitPair = true;
        console.log(
          "Unable to find unused trait pair after " + numRetries + " retries."
        );
        console.log("generated trait value pairs: " + traitValuePairs);
        break;
      }
    }

    if (failedToFindUnusedTraitPair) {
      return null;
    }

    // deal with any pairs that conflict / we dont want to happen
    traitValuePairs = await this.resolveConflicts(
      traitValuePairs,
      conflicts,
      traitValues
    );

    // for all trait value pairs, fetch the artwork representing random value
    const traitValueImagePairs = traitValuePairs.map((traitValuePair) => {
      const traitValueId = traitValuePair.traitValue?.id;
      const imageLayer = traitValueId
        ? // needs to be null not undefined for firestore
          traitValueIdToImageLayers[traitValueId] ?? null
        : null;
      traitValuePair.imageLayer = imageLayer;
      return traitValuePair;
    });

    // composite all of the images representing trait values together into one image
    const sortedTraitValueImagePairs =
      this.sortTraitValuePairs(traitValueImagePairs);

    // for any image layers with companions, inject them at the right layer level
    const sortedImageLayers = this.sortedImageLayersInjectingCompanions(
      sortedTraitValueImagePairs,
      imageLayers
    );

    const inputFilePaths = sortedImageLayers.map((imageLayer) => {
      return imageLayer ? this.downloadPathForImageLayer(imageLayer) : null;
    });

    const outputFilePath: string = path.join(
      projectDownloadPath,
      itemIndex + ".png"
    );

    const succeeded = await this.compositeImages(
      inputFilePaths,
      outputFilePath
    );

    if (succeeded) {
      // upload the composite back to the bucket
      const bucket = storage.bucket();
      const uploadFilePath =
        this.projectId +
        "/" +
        collection.id +
        "/generated/" +
        this.compositeGroupId +
        "/" +
        itemIndex +
        ".png";

      const uploadFile = bucket.file(uploadFilePath);

      const downloadURL = await bucket
        .upload(outputFilePath, {
          destination: uploadFilePath,
          metadata: {
            contentType: "image/png",
          },
        })
        .then(() => {
          return uploadFile.publicUrl();
        })
        .catch((err: Error) => {
          logger.error("error uploading file to bucket");
          logger.error(err);
        });

      const imageComposite = {
        externalURL: downloadURL,
        traits: sortedTraitValueImagePairs,
        traitsHash: ImageComposites.traitsHash(sortedTraitValueImagePairs),
      } as ImageComposite;

      return imageComposite;
    } else {
      return null;
    }
  }

  async randomTraitValues(
    traits: Trait[],
    traitValues: { [traitId: string]: TraitValue[] }
  ): Promise<TraitValuePair[]> {
    // for each trait fetch a randomly chosen value
    // based upon the distribution of rarity
    const traitValueTasks = traits.map(async (trait) => {
      return await this.randomValue(
        traitValues[trait.id],
        trait.isAlwaysUnique
      ).then(
        (value) => ({ trait: trait, traitValue: value } as TraitValuePair)
      );
    });
    return await Promise.all(traitValueTasks);
  }

  async resolveConflicts(
    traitValuePairs: TraitValuePair[],
    conflicts: Conflict[],
    traitValuesDict: { [traitId: string]: TraitValue[] }
  ): Promise<TraitValuePair[]> {
    for (let i = 0; i < conflicts.length; i++) {
      const conflict = conflicts[i];

      const trait1Index = traitValuePairs.findIndex(
        (pair) => pair.trait.id == conflict.trait1Id
      );
      if (trait1Index == -1) {
        continue;
      }

      const trait2Index = traitValuePairs.findIndex(
        (pair) => pair.trait.id == conflict.trait2Id
      );
      if (trait2Index == -1) {
        continue;
      }

      let trait1ValueIndex = -1;
      if (conflict.trait1ValueId !== null) {
        trait1ValueIndex = traitValuePairs.findIndex(
          (pair) =>
            pair.trait.id == conflict.trait1Id &&
            pair.traitValue?.id == conflict.trait1ValueId
        );
        if (trait1ValueIndex == -1) {
          continue;
        }
      }

      let trait2ValueIndex = -1;
      if (conflict.trait2ValueId !== null) {
        trait2ValueIndex = traitValuePairs.findIndex(
          (pair) =>
            pair.trait.id == conflict.trait2Id &&
            pair.traitValue?.id == conflict.trait2ValueId
        );
        if (trait2ValueIndex == -1) {
          continue;
        }
      }

      const trait1Name = traitValuePairs[trait1Index].trait.name;
      const trait2Name = traitValuePairs[trait2Index].trait.name;
      const trait1ValueName =
        trait1ValueIndex == -1
          ? "Any"
          : traitValuePairs[trait1ValueIndex].traitValue?.name ?? "Any";
      const trait2ValueName =
        trait2ValueIndex == -1
          ? "Any"
          : traitValuePairs[trait2ValueIndex].traitValue?.name ?? "Any";

      let resolution: string;

      // all matches means we have a conflict - time to handle resolution:
      switch (conflict.resolutionType) {
        case ConflictResolutionType.Trait1None:
          traitValuePairs[trait1Index].traitValue = null;
          resolution = "dropped " + trait1Name;
          break;
        case ConflictResolutionType.Trait2None:
          traitValuePairs[trait2Index].traitValue = null;
          resolution = "dropped " + trait2Name;
          break;
        case ConflictResolutionType.Trait1Random:
          const pair1 = traitValuePairs[trait1Index];
          const newRandomValue1 = await this.randomValue(
            traitValuesDict[pair1.trait.id],
            pair1.trait.isAlwaysUnique,
            pair1.traitValue?.id
          );
          traitValuePairs[trait1Index].traitValue = newRandomValue1;
          resolution = "updated " + trait1Name + " to ";
          break;
        case ConflictResolutionType.Trait2Random:
          const pair2 = traitValuePairs[trait2Index];
          const newRandomValue2 = await this.randomValue(
            traitValuesDict[pair2.trait.id],
            pair2.trait.isAlwaysUnique,
            pair2.traitValue?.id
          );
          traitValuePairs[trait2Index].traitValue = newRandomValue2;
          resolution = "updated " + trait2Name + " to ";
          break;
      }

      console.log(
        "resolved conflict for " +
          trait1Name +
          ":" +
          trait1ValueName +
          " and " +
          trait2Name +
          ":" +
          trait2ValueName +
          " " +
          resolution
      );
    }

    return traitValuePairs;
  }

  removeUsedAlwaysUniqueTraitValues(
    traits: Trait[],
    traitValues: { [traitId: string]: TraitValue[] },
    composite: ImageComposite
  ): { [traitId: string]: TraitValue[] } {
    for (let i = 0; i < traits.length; i++) {
      const trait = traits[i];
      if (trait.isAlwaysUnique) {
        let values = traitValues[trait.id];
        const compositeTraitPair = composite.traits.find((traitPair) => {
          return traitPair.trait.id == trait.id;
        });
        const compositeValue = compositeTraitPair?.traitValue;
        const matchingValueIndex = values.findIndex((value) => {
          return value.id == compositeValue?.id;
        });
        if (matchingValueIndex > -1) {
          values.splice(matchingValueIndex, 1);
          traitValues[trait.id] = values;
        }
      }
    }

    return traitValues;
  }

  /**
   * picturing a trait with 5 values (A-E) on a bar from 0 to 1
   * where each value's rarity covers some percentage of the bar
   * min 0 [--A--|-----B-----|-C-|--D--|-----E-----] max 1
   * 
   * we walk through the segments until our random number
   * between 0 and 1 lands within one of the segments

   * @param values array of possible trait values each with specified % rarity
   * @returns a secure pseudorandom value from the array factoring in rarity
   */
  async randomValue(
    values: TraitValue[],
    isTraitAlwaysUnique: boolean,
    excludeTraitValueId: string | null = null
  ): Promise<TraitValue | null> {
    if (isTraitAlwaysUnique) {
      const randomIndex = Math.floor(Math.random() * values.length);
      const randomValue = values[randomIndex];

      return randomValue;
    }

    const precision = TRAITVALUES_RARITY_MAX_PRECISION;

    let value: TraitValue | null;

    const maxAttempts = 10;
    let attempts = 0;

    do {
      if (attempts == maxAttempts) {
        return null;
      }

      value = await this.randomNumber(precision).then((randomNumber) => {
        let totalRarityRangeMax = 0;
        let segment = 0;

        while (segment < values.length) {
          const value = values[segment];
          totalRarityRangeMax += value.rarity;

          if (randomNumber <= totalRarityRangeMax) {
            return value;
          }
          segment++;
        }

        return null;
      });

      attempts++;
    } while (excludeTraitValueId != null && value?.id === excludeTraitValueId);

    return value;
  }

  /**
   * generate a secure random number from 0.0 -> 1.0
   * with specified digits of precision using the
   * random-number-csprng library
   *
   * @param digitsPrecision number of decimal places of precision
   * @returns a secure pseudorandom number
   */
  async randomNumber(digitsPrecision: number): Promise<number> {
    const rand = require("random-number-csprng");
    const max = Math.pow(10, digitsPrecision);
    const result: Promise<number> = rand(0, max).then((random: number) => {
      return random / max;
    });
    return result;
  }

  downloadPathForImageLayer(imageLayer: ImageLayer): string {
    return path.join(this.layerDownloadPath(), imageLayer.id + ".png");
  }

  async downloadImageFile(imageLayer: ImageLayer): Promise<string> {
    const bucket = storage.bucket();
    const file = bucket.file(
      this.projectId + "/" + this.collectionId + "/" + imageLayer.bucketFilename
    );

    const tempFilePath = this.downloadPathForImageLayer(imageLayer);

    // TODO: why does validation always fail if I don't disable it?
    return file
      .download({ destination: tempFilePath, validation: false })
      .then(() => {
        return tempFilePath;
      })
      .catch(() => {
        logger.error("failed to download to " + tempFilePath);
        logger.error(file.name);
        return tempFilePath;
      });
  }

  sortTraitValuePairs(traitValuePairs: TraitValuePair[]): TraitValuePair[] {
    return traitValuePairs.sort((a, b) => {
      const zIndexA = a.trait.zIndex;
      const zIndexB = b.trait.zIndex;
      if (zIndexA == zIndexB) return 0;
      return zIndexA < zIndexB ? -1 : 1;
    });
  }

  sortedImageLayersInjectingCompanions(
    sortedTraitValueImagePairs: TraitValuePair[],
    imageLayers: ImageLayer[]
  ): ImageLayer[] {
    const imageLayerPairs: OrderedImageLayer[] = [];

    sortedTraitValueImagePairs.forEach((pair) => {
      if (pair.imageLayer) {
        imageLayerPairs.push({
          imageLayer: pair.imageLayer,
          zIndex: pair.trait.zIndex,
        } as OrderedImageLayer);
      }

      const companionId = pair.imageLayer?.companionLayerId;
      const companionZIndex = pair.imageLayer?.companionLayerZIndex;

      if (companionId != null && companionZIndex != null) {
        const companionImageLayer = imageLayers.find((imageLayer) => {
          return imageLayer.id == companionId;
        });

        if (companionImageLayer) {
          imageLayerPairs.push({
            imageLayer: companionImageLayer,
            zIndex: companionZIndex,
          } as OrderedImageLayer);
        }
      }
    });

    const orderedImageLayerPairs = imageLayerPairs.sort((a, b) => {
      const zIndexA = a.zIndex;
      const zIndexB = b.zIndex;
      if (zIndexA == zIndexB) return 0;
      return zIndexA < zIndexB ? -1 : 1;
    });

    const orderedImageLayers = orderedImageLayerPairs.map((a) => {
      return a.imageLayer;
    });

    return orderedImageLayers;
  }

  compositeImages(
    optInputFilePaths: (string | null)[],
    outputFilePath: string
  ): Promise<Boolean> {
    const inputFilePaths = optInputFilePaths.filter((f) => f);
    if (inputFilePaths.length == 0) {
      return Promise.resolve(false);
    }

    const sharp = require("sharp");
    const firstPath = inputFilePaths.shift();

    if (inputFilePaths.length == 0) {
      return sharp(firstPath).png().toFile(outputFilePath);
    }

    const inputs = inputFilePaths.map((inputFilePath) => {
      return { input: inputFilePath };
    });

    return sharp(firstPath)
      .composite(inputs)
      .png()
      .toFile(outputFilePath)
      .then((_: any) => {
        return true;
      })
      .catch((err: Error) => {
        logger.error("error compositing");
        logger.error("first path: " + firstPath);
        logger.error(inputs);
        logger.error(err);
        return false;
      });
  }

  projectDownloadPath(): string {
    return path.join(tempDir, "treattoolbox", this.projectId);
  }

  layerDownloadPath(): string {
    return path.join(this.projectDownloadPath(), "layered-images");
  }
}
