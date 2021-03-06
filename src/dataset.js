import fs from 'fs';
import fsExtra from 'fs-extra';
import path from 'path';
import _ from 'underscore';
import Promise from 'bluebird';
import { leftpad } from 'apify-shared/utilities';
import LruCache from 'apify-shared/lru_cache';
import { checkParamOrThrow } from 'apify-client/build/utils';
import { ENV_VARS, LOCAL_EMULATION_SUBDIRS } from './constants';
import { apifyClient, ensureDirExists } from './utils';

export const LOCAL_EMULATION_SUBDIR = LOCAL_EMULATION_SUBDIRS.datasets;
export const LOCAL_FILENAME_DIGITS = 9;
export const LOCAL_GET_ITEMS_DEFAULT_LIMIT = 250000;
const MAX_OPENED_STORES = 1000;

const writeFilePromised = Promise.promisify(fs.writeFile);
const readFilePromised = Promise.promisify(fs.readFile);
const readdirPromised = Promise.promisify(fs.readdir);
const emptyDirPromised = Promise.promisify(fsExtra.emptyDir);

const getLocaleFilename = index => `${leftpad(index, LOCAL_FILENAME_DIGITS, 0)}.json`;

const { datasets } = apifyClient;
const datasetsCache = new LruCache({ maxLength: MAX_OPENED_STORES }); // Open Datasets are stored here.

/**
 * @typedef {Object} PaginationList
 * @property {Array} items - List of returned objects
 * @property {Number} total - Total number of object
 * @property {Number} offset - Number of Request objects that was skipped at the start.
 * @property {Number} count - Number of returned objects
 * @property {Number} limit - Requested limit
 */

/**
 * The `Dataset` class provides a simple interface to the [Apify Dataset](https://www.apify.com/docs/storage#dataset) storage.
 * You should not instantiate this class directly, use the [Apify.openDataset()](#module-Apify-openDataset) function.
 *
 * Example usage:
 *
 * ```javascript
 * const dataset = await Apify.openDataset('my-dataset-id');
 * await dataset.pushData({ foo: 'bar' });
 * ```
 *
 * @param {String} datasetId - ID of the dataset.
 */
export class Dataset {
    constructor(datasetId) {
        checkParamOrThrow(datasetId, 'datasetId', 'String');

        this.datasetId = datasetId;
    }

    /**
     * Stores object or an array of objects in the dataset.
     * The function has no result, but throws on invalid args or other errors.
     *
     * @return {Promise} That resolves when data gets saved into the dataset.
     */
    pushData(data) {
        checkParamOrThrow(data, 'data', 'Array | Object');

        return datasets.putItems({
            datasetId: this.datasetId,
            data,
        });
    }

    /**
     * Returns items in the dataset based on the provided parameters.
     *
     * If format is `json` then doesn't return an array of records but <a href="#PaginationList">PaginationList</a> instead.
     *
     * @param {Object} options
     * @param {String} [options.format='json'] - Format of the items, possible values are: json, csv, xlsx, html, xml and rss.
     * @param {Number} [options.offset=0] - Number of array elements that should be skipped at the start.
     * @param {Number} [options.limit=250000] - Maximum number of array elements to return.
     * @param {Number} [options.desc] - If 1 then the objects are sorted by createdAt in descending order.
     * @param {Array} [options.fields] - If provided then returned objects will only contain specified keys
     * @param {String} [options.unwind] - If provided then objects will be unwound based on provided field.
     * @param {Boolean} [options.disableBodyParser] - If true then response from API will not be parsed
     * @param {Number} [options.attachment] - If 1 then the response will define the Content-Disposition: attachment header, forcing a web
     *                                        browser to download the file rather than to display it. By default this header is not present.
     * @param {String} [options.delimiter=','] - A delimiter character for CSV files, only used if format=csv. You might need to URL-encode
     *                                           the character (e.g. use %09 for tab or %3B for semicolon).
     * @param {Number} [options.bom] - All responses are encoded in UTF-8 encoding. By default, the csv files are prefixed with the UTF-8 Byte
     *                                 Order Mark (BOM), while json, jsonl, xml, html and rss files are not. If you want to override this default
     *                                 behavior, specify bom=1 query parameter to include the BOM or bom=0 to skip it.
     * @param {String} [options.xmlRoot] - Overrides default root element name of xml output. By default the root element is results.
     * @param {String} [options.xmlRow] - Overrides default element name that wraps each page or page function result object in xml output.
     *                                    By default the element name is page or result based on value of simplified parameter.
     * @param {Number} [options.skipHeaderRow] - If set to `1` then header row in csv format is skipped.
     * @return {Promise}
     */
    getData(opts = {}) {
        const { datasetId } = this;
        const params = Object.assign({ datasetId }, opts);

        return datasets.getItems(params);
    }

    /**
     * Iterates over the all dataset items, yielding each in turn to an iteratee function.
     * Each invocation of iteratee is called with three arguments: (element, index).
     *
     * If iteratee returns a Promise then it's awaited before a next call.
     *
     * @param {Function} iteratee
     * @param {Opts} opts
     * @param {Number} [options.offset=0] - Number of array elements that should be skipped at the start.
     * @param {Number} [options.desc] - If 1 then the objects are sorted by createdAt in descending order.
     * @param {Array} [options.fields] - If provided then returned objects will only contain specified keys
     * @param {String} [options.unwind] - If provided then objects will be unwound based on provided field.
     * @param {Number} [options.limit=250000] - How many items to load in one request.
     * @param {Number} index [description]
     * @return {Promise<undefined>}
     */
    forEach(iteratee, opts = {}, index = 0) {
        if (!opts.offset) opts.offset = 0;
        if (opts.format && opts.format !== 'json') throw new Error('Dataset.forEach/map/reduce() support only a "json" format.');

        return this
            .getData(opts)
            .then(({ items, total, limit, offset }) => {
                return Promise
                    .mapSeries(items, item => iteratee(item, index++))
                    .then(() => {
                        const newOffset = offset + limit;

                        if (newOffset >= total) return undefined;

                        const newOpts = Object.assign({}, opts, {
                            offset: newOffset,
                        });

                        return this.forEach(iteratee, newOpts, index);
                    });
            });
    }

    /**
     * Produces a new array of values by mapping each value in list through a transformation function (iteratee).
     * Each invocation of iteratee is called with three arguments: (element, index).
     *
     * If iteratee returns a Promise then it's awaited before a next call.
     *
     * @param {Function} iteratee
     * @param {Opts} opts
     * @param {Number} [options.offset=0] - Number of array elements that should be skipped at the start.
     * @param {Number} [options.desc] - If 1 then the objects are sorted by createdAt in descending order.
     * @param {Array} [options.fields] - If provided then returned objects will only contain specified keys
     * @param {String} [options.unwind] - If provided then objects will be unwound based on provided field.
     * @param {Number} [options.limit=250000] - How many items to load in one request.
     * @param {Number} index [description]
     * @return {Promise<Array>}
     */
    map(iteratee, opts) {
        const result = [];

        const wrappedFunc = (item, index) => {
            return Promise
                .resolve()
                .then(() => iteratee(item, index))
                .then(res => result.push(res));
        };

        return this
            .forEach(wrappedFunc, opts)
            .then(() => result);
    }

    /**
     * Memo is the initial state of the reduction, and each successive step of it should be returned by iteratee.
     * The iteratee is passed three arguments: the memo, then the value and index of the iteration.
     *
     * If no memo is passed to the initial invocation of reduce, the iteratee is not invoked on the first element of the list.
     * The first element is instead passed as the memo in the invocation of the iteratee on the next element in the list.
     *
     * If iteratee returns a Promise then it's awaited before a next call.
     *
     * @param {Function} iteratee
     * @param {*} memo
     * @param {Opts} opts
     * @param {Number} [options.offset=0] - Number of array elements that should be skipped at the start.
     * @param {Number} [options.desc] - If 1 then the objects are sorted by createdAt in descending order.
     * @param {Array} [options.fields] - If provided then returned objects will only contain specified keys
     * @param {String} [options.unwind] - If provided then objects will be unwound based on provided field.
     * @param {Number} [options.limit=250000] - How many items to load in one request.
     * @param {Number} index [description]
     * @return {Promise<*>}
     */
    reduce(iteratee, memo, opts) {
        let currentMemo = memo;

        const wrappedFunc = (item, index) => {
            return Promise
                .resolve()
                .then(() => {
                    return !index && currentMemo === undefined
                        ? item
                        : iteratee(currentMemo, item, index);
                })
                .then((newMemo) => {
                    currentMemo = newMemo;
                });
        };

        return this
            .forEach(wrappedFunc, opts)
            .then(() => currentMemo);
    }

    /**
     * Deletes the dataset.
     *
     * @return {Promise}
     */
    delete() {
        return datasets
            .deleteDataset({
                datasetId: this.datasetId,
            })
            .then(() => {
                datasetsCache.remove(this.datasetId);
            });
    }
}

/**
 * This is a local emulation of a dataset.
 *
 * @ignore
 */
export class DatasetLocal {
    constructor(datasetId, localEmulationDir) {
        checkParamOrThrow(datasetId, 'datasetId', 'String');
        checkParamOrThrow(localEmulationDir, 'localEmulationDir', 'String');

        this.localEmulationPath = path.resolve(path.join(localEmulationDir, LOCAL_EMULATION_SUBDIR, datasetId));
        this.counter = null;
        this.datasetId = datasetId;
        this.initializationPromise = this._initialize();
    }

    _initialize() {
        return ensureDirExists(this.localEmulationPath)
            .then(() => readdirPromised(this.localEmulationPath))
            .then((files) => {
                if (files.length) {
                    const lastFileNum = files.pop().split('.')[0];

                    this.counter = parseInt(lastFileNum, 10);
                } else {
                    this.counter = 0;
                }
            });
    }

    pushData(data) {
        checkParamOrThrow(data, 'data', 'Array | Object');

        if (!_.isArray(data)) data = [data];

        return this.initializationPromise
            .then(() => {
                const promises = data.map((item) => {
                    this.counter++;

                    // Format JSON to simplify debugging, the overheads is negligible
                    const itemStr = JSON.stringify(item, null, 2);
                    const filePath = path.join(this.localEmulationPath, getLocaleFilename(this.counter));

                    return writeFilePromised(filePath, itemStr);
                });

                return Promise.all(promises);
            });
    }

    getData(opts = {}) {
        checkParamOrThrow(opts, 'opts', 'Object');
        checkParamOrThrow(opts.limit, 'opts.limit', 'Maybe Number');
        checkParamOrThrow(opts.offset, 'opts.offset', 'Maybe Number');

        if (!opts.limit) opts.limit = LOCAL_GET_ITEMS_DEFAULT_LIMIT;
        if (!opts.offset) opts.offset = 0;

        return this.initializationPromise
            .then(() => {
                const indexes = this._getItemIndexes(opts.offset, opts.limit);

                return Promise.mapSeries(indexes, index => this._readAndParseFile(index));
            })
            .then((items) => {
                return {
                    items,
                    total: this.counter,
                    offset: opts.offset,
                    count: items.length,
                    limit: opts.limit,
                };
            });
    }

    forEach(iteratee) {
        return this.initializationPromise
            .then(() => {
                const indexes = this._getItemIndexes();

                return Promise.each(indexes, (index) => {
                    return this
                        ._readAndParseFile(index)
                        .then(item => iteratee(item, index - 1));
                });
            })
            .then(() => undefined);
    }

    map(iteratee) {
        return this.initializationPromise
            .then(() => {
                const indexes = this._getItemIndexes();

                return Promise
                    .map(indexes, (index) => {
                        return this
                            ._readAndParseFile(index)
                            .then(item => iteratee(item, index - 1));
                    });
            });
    }

    reduce(iteratee, memo) {
        return this.initializationPromise
            .then(() => {
                const indexes = this._getItemIndexes();

                return Promise
                    .reduce(indexes, (currentMemo, index) => {
                        return this
                            ._readAndParseFile(index)
                            .then(item => iteratee(currentMemo, item, index - 1));
                    }, memo);
            });
    }

    delete() {
        return this.initializationPromise
            .then(() => emptyDirPromised(this.localEmulationPath))
            .then(() => {
                datasetsCache.remove(this.datasetId);
            });
    }

    /**
     * Returns an array of item indexes for given offset and limit.
     */
    _getItemIndexes(offset = 0, limit = this.counter) {
        if (limit === null) throw new Error('DatasetLocal must be initialize before calling this._getItemIndexes()!');

        return _.range(
            offset + 1,
            Math.min(offset + limit, this.counter) + 1,
        );
    }

    /**
     * Reads and parses file for given index.
     */
    _readAndParseFile(index) {
        const filePath = path.join(this.localEmulationPath, getLocaleFilename(index));

        return readFilePromised(filePath)
            .then(json => JSON.parse(json));
    }
}

/**
 * Helper function that first requests dataset by ID and if dataset doesn't exist then gets it by name.
 *
 * @ignore
 */
const getOrCreateDataset = (datasetIdOrName) => {
    return datasets
        .getDataset({ datasetId: datasetIdOrName })
        .then((existingDataset) => {
            if (existingDataset) return existingDataset;

            return datasets.getOrCreateDataset({ datasetName: datasetIdOrName });
        });
};


/**
 * Opens a dataset and returns a promise resolving to an instance of the [Dataset](#Dataset) object.
 *
 * Dataset is an append-only storage that is useful for storing sequential or tabular results.
 * For more information, see [Dataset documentation](https://www.apify.com/docs/storage#dataset).
 *
 * Example usage:
 *
 * ```javascript
 * const store = await Apify.openDataset(); // Opens the default dataset of the run.
 * const storeWithName = await Apify.openDataset('some-name'); // Opens dataset with name 'some-name'.
 *
 * // Write a single row to dataset
 * await dataset.pushData({ foo: 'bar' });
 *
 * // Write multiple rows
 * await dataset.pushData([
 *   { foo: 'bar2', col2: 'val2' },
 *   { col3: 123 },
 * ]);
 * ```
 *
 * If the `APIFY_LOCAL_EMULATION_DIR` environment variable is set, the result of this function
 * is an instance of the `DatasetLocal` class which stores the data in a local directory
 * rather than Apify cloud. This is useful for local development and debugging of your acts.
 *
 * @param {string} datasetIdOrName ID or name of the dataset to be opened. If no value is provided
 *                                 then the function opens the default dataset associated with the act run.
 * @returns {Promise<Dataset>} Returns a promise that resolves to a `Dataset` object.
 *
 * @memberof module:Apify
 * @name openDataset
 * @instance
 * @function
 */
export const openDataset = (datasetIdOrName) => {
    checkParamOrThrow(datasetIdOrName, 'datasetIdOrName', 'Maybe String');

    const localEmulationDir = process.env[ENV_VARS.LOCAL_EMULATION_DIR];

    let isDefault = false;
    let datasetPromise;

    if (!datasetIdOrName) {
        const envVar = ENV_VARS.DEFAULT_DATASET_ID;

        // Env var doesn't exist.
        if (!process.env[envVar]) return Promise.reject(new Error(`The '${envVar}' environment variable is not defined.`));

        isDefault = true;
        datasetIdOrName = process.env[envVar];
    }

    datasetPromise = datasetsCache.get(datasetIdOrName);

    // Found in cache.
    if (datasetPromise) return datasetPromise;

    // Use local emulation?
    if (localEmulationDir) {
        datasetPromise = Promise.resolve(new DatasetLocal(datasetIdOrName, localEmulationDir));
    } else {
        datasetPromise = isDefault // If true then we know that this is an ID of existing dataset.
            ? Promise.resolve(new Dataset(datasetIdOrName))
            : getOrCreateDataset(datasetIdOrName).then(dataset => (new Dataset(dataset.id)));
    }

    datasetsCache.add(datasetIdOrName, datasetPromise);

    return datasetPromise;
};

/**
 * Stores object or an array of objects in the default dataset for the current act run using the Apify API
 * Default id of the dataset is in the `APIFY_DEFAULT_DATASET_ID` environment variable
 * The function has no result, but throws on invalid args or other errors.
 *
 * ```javascript
 * await Apify.pushData(data);
 * ```
 *
 * The data is stored in default dataset associated with this act.
 *
 * If the `APIFY_LOCAL_EMULATION_DIR` environment variable is defined, the data gets pushed into local directory.
 * This feature is useful for local development and debugging of your acts.
 *
 * **IMPORTANT**: Do not forget to use the `await` keyword when calling `Apify.pushData()`,
 * otherwise the act process might finish before the data is stored!
 *
 * @param {Object|Array} data Object or array of objects containing data to by stored in the dataset (9MB Max)
 * @returns {Promise} Returns a promise that gets resolved once data are saved.
 *
 * @memberof module:Apify
 * @name pushData
 * @instance
 * @function
 */
export const pushData = item => openDataset().then(dataset => dataset.pushData(item));
