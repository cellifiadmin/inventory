/**
 * Ensures a nested path exists in an object, creating empty objects along the way.
 * Returns the final nested object at the end of the path.
 * 
 * @example
 * const obj = {};
 * ensurePath(obj, ['catalogItem', 'model', 'brand']).key = 'value';
 * // Result: { catalogItem: { model: { brand: { key: 'value' } } } }
 * 
 * @param obj - The object to traverse/create paths in
 * @param path - Array of keys representing the nested path
 * @returns The object at the end of the path
 */
export const ensurePath = (obj: any, path: string[]): any => {
    let current = obj;
    for (const key of path) {
        if (!current[key]) current[key] = {};
        current = current[key];
    }
    return current;
};

